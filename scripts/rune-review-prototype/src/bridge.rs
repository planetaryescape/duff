//! Owned Node subprocess. Provider/Git work never runs on Rune's rendering thread.
use rune::Waker;
use serde::Deserialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};

#[derive(Clone, Deserialize)]
pub struct PullRequest {
    pub id: String,
    pub title: String,
    pub author: String,
    pub branch: String,
}

#[derive(Clone, Deserialize)]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
    pub viewed: bool,
}

#[derive(Clone, Deserialize)]
pub struct Saved {
    pub session: String,
    pub title: String,
    pub repository: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Payload {
    List {
        repository_label: String,
        items: Vec<PullRequest>,
        has_more: bool,
    },
    Review {
        session: String,
        title: String,
        author: String,
        branch: String,
        base_commit: String,
        head_commit: String,
        files: Vec<ChangedFile>,
        last_file: Option<String>,
    },
    File {
        session: String,
        path: String,
        old_text: String,
        new_text: String,
        binary: bool,
    },
    Viewed {
        session: String,
        path: String,
        viewed: bool,
    },
    Saved {
        items: Vec<Saved>,
    },
    Language {
        session: String,
        state: String,
        message: String,
    },
    Hover {
        session: String,
        path: String,
        side: String,
        line: u32,
        character: u32,
        content: String,
        message: String,
    },
    Definition {
        session: String,
        path: String,
        side: String,
        targets: Vec<DefinitionTarget>,
        message: String,
    },
    #[serde(rename = "language-cancelled")]
    LanguageCancelled,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionTarget {
    pub path: String,
    pub commit: String,
    pub line: u32,
    pub character: u32,
    pub start_line: u32,
    pub text: String,
}

pub struct Event {
    pub id: u64,
    pub result: Result<Payload, String>,
}

pub struct Bridge {
    child: Child,
    input: Arc<Mutex<Option<ChildStdin>>>,
    requests: SyncSender<Value>,
    pub replies: Receiver<Event>,
}

impl Bridge {
    pub fn start(wake: Waker) -> Result<Self, String> {
        let script = std::env::var_os("DUFF_BRIDGE").unwrap_or_else(|| {
            concat!(env!("CARGO_MANIFEST_DIR"), "/bridge/dist/bridge.mjs").into()
        });
        let mut child =
            Command::new(std::env::var_os("DUFF_NODE").unwrap_or_else(|| "node".into()))
                .arg(script)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| {
                    "Cannot start Node. Run the launcher with Node 22.18+ installed.".to_owned()
                })?;
        let pipes = child.stdin.take().zip(child.stdout.take());
        let Some((input, output)) = pipes else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Cannot connect to the local core bridge.".to_owned());
        };
        let input = Arc::new(Mutex::new(Some(input)));
        let worker_input = input.clone();
        let (requests, incoming) = mpsc::sync_channel::<Value>(32);
        let (outgoing, replies) = mpsc::channel();
        let write_errors = outgoing.clone();
        let write_wake = wake.clone();
        std::thread::spawn(move || {
            for request in incoming {
                let id = request.get("id").and_then(Value::as_u64).unwrap_or(0);
                let result = (|| {
                    let mut guard = worker_input.lock().map_err(|_| ())?;
                    let input = guard.as_mut().ok_or(())?;
                    serde_json::to_writer(&mut *input, &request).map_err(|_| ())?;
                    input
                        .write_all(b"\n")
                        .and_then(|_| input.flush())
                        .map_err(|_| ())
                })();
                if result.is_err() {
                    let _ = write_errors.send(Event {
                        id,
                        result: Err(
                            "Local core bridge disconnected. Restart Duff with the launcher."
                                .to_owned(),
                        ),
                    });
                    write_wake();
                    break;
                }
            }
        });
        std::thread::spawn(move || {
            let mut output = BufReader::new(output);
            loop {
                let decoded = (|| {
                    let mut line = String::new();
                    // Core bounds each file to 1 MiB; allow JSON escaping without unbounded reads.
                    let count = output
                        .by_ref()
                        .take(16 * 1024 * 1024)
                        .read_line(&mut line)
                        .map_err(|_| ())?;
                    if count == 0 || !line.ends_with('\n') {
                        return Err(());
                    }
                    let value: Value = serde_json::from_str(&line).map_err(|_| ())?;
                    let id = value.get("id").and_then(Value::as_u64).ok_or(())?;
                    let result = if value.get("ok") == Some(&Value::Bool(true)) {
                        serde_json::from_value(value).map(Ok).map_err(|_| ())
                    } else {
                        // Only the bridge's finite public diagnostics cross into native UI.
                        let message = match value.get("error").and_then(Value::as_str) {
                            Some(
                                "Authentication unavailable. Sign in with the provider CLI and retry.",
                            ) => "Authentication unavailable. Sign in with gh or az, then retry.",
                            Some("Binary, oversized, or unsupported file unavailable.") => {
                                "Binary, oversized, or unsupported file. No empty diff has been substituted."
                            }
                            Some("Saved review storage unavailable.") => {
                                "Saved review storage unavailable. Check the standalone data directory."
                            }
                            Some("Language analysis unavailable.") => {
                                "Language analysis unavailable. Review reading and viewed progress still work."
                            }
                            _ => "Review operation unavailable. Check repository access and retry.",
                        };
                        Ok(Err(message.to_owned()))
                    }?;
                    Ok(Event { id, result })
                })();
                match decoded {
                    Ok(event) => {
                        if outgoing.send(event).is_err() {
                            break;
                        }
                        wake();
                    }
                    Err(()) => {
                        let _ = outgoing.send(Event {
                            id: 0,
                            result: Err(
                                "Local core bridge disconnected. Restart Duff with the launcher."
                                    .to_owned(),
                            ),
                        });
                        wake();
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            input,
            requests,
            replies,
        })
    }

    pub fn send(&self, request: Value) -> bool {
        self.requests.try_send(request).is_ok()
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        // The sidecar observes this control line even while awaiting a Git request.
        // Do not SIGKILL Node: Effect must finalize its owned Git/SSH process groups.
        if let Ok(mut guard) = self.input.lock() {
            if let Some(mut input) = guard.take() {
                let _ = input.write_all(b"{\"op\":\"shutdown\"}\n");
                let _ = input.flush();
            }
        }
        // Wait for owned cleanup, rather than timing out and orphaning descendants.
        let _ = self.child.wait();
    }
}
