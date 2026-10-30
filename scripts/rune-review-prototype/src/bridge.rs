//! Owned Node subprocess. Provider/Git work never runs on Rune's rendering thread.
use rune::Waker;
use serde::Deserialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
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
}

pub type Event = Result<Payload, String>;

pub struct Bridge {
    child: Child,
    input: Arc<Mutex<Option<ChildStdin>>>,
    requests: Sender<Value>,
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
        let (requests, incoming) = mpsc::channel::<Value>();
        let (outgoing, replies) = mpsc::channel();
        std::thread::spawn(move || {
            let mut output = BufReader::new(output);
            for request in incoming {
                let result = (|| {
                    {
                        let mut guard = worker_input.lock().map_err(|_| ())?;
                        let input = guard.as_mut().ok_or(())?;
                        serde_json::to_writer(&mut *input, &request).map_err(|_| ())?;
                        input.write_all(b"\n").and_then(|_| input.flush()).map_err(|_| ())?;
                    }
                    let mut line = String::new();
                    // Core bounds each file to 1 MiB; allow JSON escaping without unbounded reads.
                    let count = output.by_ref().take(16 * 1024 * 1024).read_line(&mut line).map_err(|_| ())?;
                    if count == 0 || !line.ends_with('\n') { return Err(()); }
                    let value: Value = serde_json::from_str(&line).map_err(|_| ())?;
                    if value.get("id") != request.get("id") { return Err(()); }
                    if value.get("ok") == Some(&Value::Bool(true)) {
                        serde_json::from_value(value).map(Ok).map_err(|_| ())
                    } else {
                        // Only the bridge's finite public diagnostics cross into native UI.
                        let message = match value.get("error").and_then(Value::as_str) {
                            Some("Authentication unavailable. Sign in with the provider CLI and retry.") => "Authentication unavailable. Sign in with gh or az, then retry.",
                            Some("Binary, oversized, or unsupported file unavailable.") => "Binary, oversized, or unsupported file. No empty diff has been substituted.",
                            Some("Saved review storage unavailable.") => "Saved review storage unavailable. Check the standalone data directory.",
                            _ => "Review operation unavailable. Check repository access and retry.",
                        };
                        Ok(Err(message.to_owned()))
                    }
                })().unwrap_or_else(|()| Err("Local core bridge disconnected. Restart Duff with the launcher.".to_owned()));
                if outgoing.send(result).is_err() {
                    break;
                }
                wake();
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
        self.requests.send(request).is_ok()
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
