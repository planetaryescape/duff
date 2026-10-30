//! Native local-first PR review over Duff's existing Effect core. No fixture mode.
mod bridge;

use bridge::{Bridge, ChangedFile, Payload, PullRequest, Saved};
use rune::{
    App, AppSpec, Color, Cx, El, KeyEvent, ScrollSpec, TextEdit, TextStyle, col, row, text,
};
use rune_kit::{
    Kit, TextInput,
    diff::{DiffMode, DiffState, DiffView, FileDiff},
};
use serde_json::{Value, json};

const BG: Color = Color {
    r: 0.006,
    g: 0.008,
    b: 0.009,
    a: 1.0,
};
const PANEL: Color = Color {
    r: 0.009,
    g: 0.012,
    b: 0.014,
    a: 1.0,
};
const BORDER: Color = Color {
    r: 0.025,
    g: 0.029,
    b: 0.032,
    a: 1.0,
};
const INK: Color = Color {
    r: 0.78,
    g: 0.78,
    b: 0.74,
    a: 1.0,
};
const MUTED: Color = Color {
    r: 0.28,
    g: 0.30,
    b: 0.32,
    a: 1.0,
};
const AMBER: Color = Color {
    r: 0.72,
    g: 0.46,
    b: 0.17,
    a: 1.0,
};
const SELECTED: Color = Color {
    r: 0.032,
    g: 0.026,
    b: 0.016,
    a: 1.0,
};
const GREEN: Color = Color {
    r: 0.18,
    g: 0.48,
    b: 0.30,
    a: 1.0,
};

struct Review {
    session: String,
    title: String,
    author: String,
    branch: String,
    base: String,
    head: String,
    files: Vec<ChangedFile>,
}

struct State {
    bridge: Option<Bridge>,
    serial: u64,
    busy: bool,
    status: String,
    error: bool,
    destination: TextEdit,
    author: TextEdit,
    repository: String,
    list_destination: String,
    prs: Vec<PullRequest>,
    has_more: bool,
    appending: bool,
    saved: Vec<Saved>,
    show_saved: bool,
    review: Option<Review>,
    file: usize,
    loaded: bool,
    diff: DiffState,
    layout: usize,
    inbox_open: bool,
}

impl State {
    fn request(&mut self, mut request: Value, status: &str) {
        if self.busy {
            return;
        }
        self.serial += 1;
        request["id"] = json!(self.serial);
        if self
            .bridge
            .as_ref()
            .is_some_and(|bridge| bridge.send(request))
        {
            self.busy = true;
            self.error = false;
            self.status = status.to_owned();
        } else {
            self.error = true;
            self.status = "Local core bridge unavailable. Restart using run.sh.".to_owned();
        }
    }

    fn list(&mut self, more: bool) {
        if self.busy {
            return;
        }
        let destination = self.destination.text.trim().to_owned();
        if destination.is_empty() {
            self.status = "Enter a GitHub or Azure repository URL.".to_owned();
            return;
        }
        if more && destination != self.list_destination {
            return;
        }
        if destination != self.list_destination {
            self.prs.clear();
            self.has_more = false;
            self.repository.clear();
        }
        self.appending = more;
        self.list_destination = destination.clone();
        self.request(
            json!({"op":"list", "destination":destination, "more":more}),
            "Loading real pull requests…",
        );
    }

    fn select(&mut self, index: usize) {
        if self.busy {
            return;
        }
        if let Some(pr) = self.prs.get(index) {
            self.request(
                json!({"op":"prepare", "destination":self.list_destination, "pr":pr.id}),
                "Acquiring pinned commits into an isolated workspace…",
            );
        }
    }

    fn open_file(&mut self, index: usize) {
        if self.busy {
            return;
        }
        if let Some(review) = &self.review {
            if let Some(file) = review.files.get(index) {
                let request = json!({"op":"file", "session":review.session, "path":file.path});
                self.file = index;
                self.loaded = false;
                let mode = self.diff.mode();
                self.diff = DiffState::default();
                self.diff.set_mode(mode);
                self.request(request, "Reading immutable Git blobs…");
            }
        }
    }

    fn toggle_viewed(&mut self) {
        if !self.loaded {
            return;
        }
        if let Some(review) = &self.review {
            if let Some(file) = review.files.get(self.file) {
                self.request(json!({"op":"viewed", "session":review.session, "path":file.path, "viewed":!file.viewed}), "Saving viewed progress…");
            }
        }
    }

    fn next_unviewed(&mut self) {
        if let Some(review) = &self.review {
            let n = review.files.len();
            if let Some(index) = (1..=n)
                .map(|step| (self.file + step) % n)
                .find(|index| !review.files[*index].viewed)
            {
                self.open_file(index);
            }
        }
    }

    fn count(&self) -> usize {
        self.review.as_ref().map_or(0, |review| {
            review.files.iter().filter(|file| file.viewed).count()
        })
    }

    fn accept(&mut self, payload: Payload) {
        match payload {
            Payload::List {
                repository_label,
                items,
                has_more,
            } => {
                self.repository = repository_label;
                if self.appending {
                    self.prs.extend(items);
                } else {
                    self.prs = items;
                }
                self.has_more = has_more;
                self.show_saved = false;
                self.status = format!(
                    "{} open PRs loaded{} · author filter applies to loaded pages",
                    self.prs.len(),
                    if has_more { " · more available" } else { "" }
                );
            }
            Payload::Review {
                session,
                title,
                author,
                branch,
                base_commit,
                head_commit,
                files,
                last_file,
            } => {
                let index = last_file
                    .and_then(|path| files.iter().position(|file| file.path == path))
                    .unwrap_or(0);
                self.review = Some(Review {
                    session,
                    title,
                    author,
                    branch,
                    base: base_commit,
                    head: head_commit,
                    files,
                });
                self.inbox_open = self.layout != 1;
                self.loaded = false;
                let mode = self.diff.mode();
                self.diff = DiffState::default();
                self.diff.set_mode(mode);
                self.status = "Pinned review ready. No working branch was changed.".to_owned();
                self.open_file(index);
            }
            Payload::File {
                session,
                path,
                old_text,
                new_text,
                binary,
            } => {
                if self.review.as_ref().is_some_and(|review| {
                    review.session == session
                        && review
                            .files
                            .get(self.file)
                            .is_some_and(|file| file.path == path)
                }) {
                    if binary {
                        self.status = "Binary file unavailable; no diff substituted.".to_owned();
                        self.error = true;
                    } else {
                        let mode = self.diff.mode();
                        self.diff =
                            DiffState::new(vec![FileDiff::from_texts(&path, &old_text, &new_text)]);
                        self.diff.set_mode(mode);
                        self.diff.set_wrap(true);
                        self.loaded = true;
                        self.status = "Immutable Git blobs · viewed progress saved locally · no provider writes".to_owned();
                    }
                }
            }
            Payload::Viewed {
                session,
                path,
                viewed,
            } => {
                if let Some(review) = &mut self.review {
                    if review.session == session {
                        if let Some(file) = review.files.iter_mut().find(|file| file.path == path) {
                            file.viewed = viewed;
                        }
                    }
                }
                self.status =
                    "Viewed progress saved. Resume restores this exact comparison.".to_owned();
            }
            Payload::Saved { items } => {
                self.saved = items;
                self.show_saved = true;
                self.status = format!(
                    "{} saved reviews · standalone storage only",
                    self.saved.len()
                );
            }
        }
    }
}

fn init() -> State {
    let mut diff = DiffState::default();
    diff.set_mode(DiffMode::Split);
    State {
        bridge: None,
        serial: 0,
        busy: false,
        status: "Starting local Effect core…".to_owned(),
        error: false,
        destination: TextEdit::new(std::env::var("DUFF_REPOSITORY").unwrap_or_default()),
        author: TextEdit::new(""),
        repository: String::new(),
        list_destination: String::new(),
        prs: vec![],
        has_more: false,
        appending: false,
        saved: vec![],
        show_saved: false,
        review: None,
        file: 0,
        loaded: false,
        diff,
        layout: 0,
        inbox_open: true,
    }
}

fn label(value: impl Into<String>, font: TextStyle, color: Color) -> El {
    text(value).font(font).color(color)
}
fn line() -> El {
    row().w_full().h(1.0).fill(BORDER)
}
fn action(
    key: impl Into<String>,
    title: impl Into<String>,
    active: bool,
    k: &Kit,
    f: impl Fn(&mut State) + 'static,
) -> El {
    row()
        .key(key)
        .role("button")
        .focusable(true)
        .h(30.0)
        .px(10.0)
        .items_center()
        .radius(4.0)
        .fill(if active { SELECTED } else { PANEL })
        .border(1.0, if active { AMBER } else { BORDER })
        .hover(BORDER)
        .on_press(f)
        .child(label(title, k.ty.ui, if active { AMBER } else { INK }))
}

fn inbox(s: &State, k: &Kit, wide: bool) -> El {
    let mut list = col().key("inbox-list").w_full().gap(5.0).padding(10.0);
    if s.show_saved {
        for (index, saved) in s.saved.iter().enumerate() {
            let session = saved.session.clone();
            list = list.child(
                col()
                    .key(format!("saved-{index}"))
                    .role("button")
                    .focusable(true)
                    .w_full()
                    .padding(12.0)
                    .gap(7.0)
                    .radius(5.0)
                    .fill(PANEL)
                    .hover(BORDER)
                    .on_press(move |s: &mut State| {
                        s.request(
                            json!({"op":"resume", "session":session}),
                            "Resuming the saved pinned comparison…",
                        )
                    })
                    .child(label(&saved.title, k.ty.ui_medium, INK).wrap())
                    .child(label(&saved.repository, k.ty.ui, MUTED).wrap()),
            );
        }
        if s.saved.is_empty() {
            list = list.child(label("No saved standalone reviews yet.", k.ty.ui, MUTED).wrap());
        }
    } else {
        let filter = s.author.text.trim().to_lowercase();
        let mut visible = 0;
        for (index, pr) in s
            .prs
            .iter()
            .enumerate()
            .filter(|(_, pr)| pr.author.to_lowercase().contains(&filter))
        {
            visible += 1;
            list = list.child(
                col()
                    .key(format!("pr-{index}"))
                    .role("button")
                    .focusable(true)
                    .label(format!("Review pull request {} by {}", pr.id, pr.author))
                    .w_full()
                    .padding(12.0)
                    .gap(8.0)
                    .radius(5.0)
                    .fill(PANEL)
                    .border(1.0, BORDER)
                    .hover(BORDER)
                    .on_press(move |s: &mut State| s.select(index))
                    .child(label(format!("#{}  {}", pr.id, pr.title), k.ty.ui_medium, INK).wrap())
                    .child(label(&pr.author, k.ty.ui, AMBER).wrap())
                    .child(label(&pr.branch, k.ty.ui, MUTED).wrap()),
            );
        }
        if visible == 0 {
            list = list.child(
                label(
                    if s.prs.is_empty() {
                        "Load a repository to see its real open pull requests."
                    } else {
                        "No authors match on loaded pages."
                    },
                    k.ty.ui,
                    MUTED,
                )
                .wrap(),
            );
        }
        if s.has_more {
            list = list.child(action("load-more", "Load more PRs", false, k, |s| {
                s.list(true)
            }));
        }
    }
    col()
        .key("inbox")
        .w(if wide { 420.0 } else { 330.0 })
        .h_full()
        .fill(PANEL)
        .child(
            col()
                .padding(16.0)
                .gap(10.0)
                .child(label("PULL REQUESTS", k.ty.ui_medium, MUTED))
                .child(
                    label(
                        if s.repository.is_empty() {
                            "Your review inbox"
                        } else {
                            &s.repository
                        },
                        TextStyle::new(21.0, 600.0),
                        INK,
                    )
                    .wrap(),
                )
                .child(
                    TextInput::new(&s.author)
                        .placeholder("Filter by author…")
                        .on_edit(|s: &mut State| &mut s.author)
                        .build(k),
                )
                .child(
                    row()
                        .gap(7.0)
                        .child(action("open-prs", "Open PRs", !s.show_saved, k, |s| {
                            s.show_saved = false
                        }))
                        .child(action(
                            "saved-reviews",
                            "Saved reviews",
                            s.show_saved,
                            k,
                            |s| s.request(json!({"op":"saved"}), "Loading saved reviews…"),
                        )),
                ),
        )
        .child(line())
        .child(
            col()
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(list),
        )
        .child(
            col().padding(16.0).child(
                label(
                    "GitHub: gh auth login\nAzure: az login\nUses existing CLI authentication.",
                    k.ty.ui,
                    MUTED,
                )
                .wrap(),
            ),
        )
}

fn file_rail(s: &State, k: &Kit) -> El {
    let files = s
        .review
        .as_ref()
        .map_or(&[][..], |review| review.files.as_slice());
    let mut entries = col().w_full().gap(5.0);
    for (index, file) in files.iter().enumerate() {
        entries = entries.child(
            col()
                .key(format!("file-{index}"))
                .role("button")
                .focusable(true)
                .w_full()
                .padding(10.0)
                .gap(5.0)
                .radius(4.0)
                .fill(if s.file == index { SELECTED } else { PANEL })
                .hover(BORDER)
                .on_press(move |s: &mut State| s.open_file(index))
                .child(
                    label(
                        format!("{}  {}", if file.viewed { "✓" } else { "·" }, file.path),
                        k.ty.ui,
                        if file.viewed { GREEN } else { INK },
                    )
                    .wrap(),
                )
                .child(label(&file.status, k.ty.ui, MUTED)),
        );
    }
    col()
        .key("files")
        .w(245.0)
        .h_full()
        .fill(PANEL)
        .padding(14.0)
        .gap(10.0)
        .child(label("CHANGED FILES", k.ty.ui_medium, MUTED))
        .child(label(
            format!("{} / {} viewed", s.count(), files.len()),
            k.ty.ui,
            GREEN,
        ))
        .child(line())
        .child(
            col()
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(entries),
        )
        .child(label("j / k   Next / previous hunk", k.ty.ui, MUTED))
}

fn empty_review(s: &State, k: &Kit) -> El {
    col().grow(1.0).min_w(0.0).h_full().padding(36.0).gap(18.0)
        .child(label("Review, without the detours.", TextStyle::new(28.0, 600.0), INK))
        .child(label("Paste a GitHub or Azure repository URL, load its pull requests, and choose a review.", k.ty.ui, MUTED).wrap())
        .child(label("Duff acquires exact commits into its own local workspace. Your existing working branch stays untouched.", k.ty.ui, MUTED).wrap())
        .child(label(if s.busy { "Working…" } else { "Or reopen a saved review from the inbox." }, k.ty.ui_medium, AMBER))
}

fn review(s: &State, k: &Kit, tabs: bool) -> El {
    let Some(review) = &s.review else {
        return empty_review(s, k);
    };
    let viewed = review.files.get(s.file).is_some_and(|file| file.viewed);
    let title = col()
        .w_full()
        .padding(18.0)
        .gap(10.0)
        .child(label(&review.title, TextStyle::new(21.0, 600.0), INK).wrap())
        .child(
            label(
                format!("{}  ·  {}", review.author, review.branch),
                k.ty.ui,
                MUTED,
            )
            .wrap(),
        )
        .child(
            row()
                .gap(10.0)
                .child(label(
                    format!(
                        "PINNED  {} → {}",
                        &review.base[..review.base.len().min(10)],
                        &review.head[..review.head.len().min(10)]
                    ),
                    k.ty.ui,
                    AMBER,
                ))
                .child(row().grow(1.0))
                .child(label(
                    format!("{} / {} viewed", s.count(), review.files.len()),
                    k.ty.ui_medium,
                    GREEN,
                )),
        );
    let toolbar = row()
        .h(45.0)
        .w_full()
        .px(12.0)
        .gap(6.0)
        .items_center()
        .fill(PANEL)
        .child(action(
            "unified",
            "Unified",
            s.diff.mode() == DiffMode::Unified,
            k,
            |s| s.diff.set_mode(DiffMode::Unified),
        ))
        .child(action(
            "split",
            "Split",
            s.diff.mode() == DiffMode::Split,
            k,
            |s| s.diff.set_mode(DiffMode::Split),
        ))
        .child(row().grow(1.0))
        .child(action(
            "mark-viewed",
            if viewed { "✓ Viewed" } else { "Mark viewed" },
            viewed,
            k,
            State::toggle_viewed,
        ))
        .child(action(
            "next-unviewed",
            "Next unviewed →",
            false,
            k,
            State::next_unviewed,
        ));
    let mut panel = col()
        .key("review")
        .grow(1.0)
        .min_w(0.0)
        .h_full()
        .fill(BG)
        .child(title)
        .child(line());
    if tabs {
        let mut bar = row().gap(6.0).padding(10.0);
        for (index, file) in review
            .files
            .iter()
            .enumerate()
            .skip(s.file.saturating_sub(1))
            .take(3)
        {
            bar = bar.child(action(
                format!("tab-{index}"),
                file.path.rsplit('/').next().unwrap_or(&file.path),
                s.file == index,
                k,
                move |s| s.open_file(index),
            ));
        }
        panel = panel.child(bar);
    }
    panel = panel.child(toolbar);
    if s.loaded {
        panel.child(DiffView::new(|s: &State| &s.diff, |s: &mut State| &mut s.diff).build(s, k))
    } else {
        panel.child(
            col()
                .grow(1.0)
                .w_full()
                .padding(24.0)
                .gap(14.0)
                .child(
                    label(
                        if s.busy {
                            "Reading pinned content…"
                        } else if review.files.is_empty() {
                            "No changed files in this comparison."
                        } else {
                            "File content unavailable. Retry or select another file."
                        },
                        k.ty.ui,
                        MUTED,
                    )
                    .wrap(),
                )
                .child(action("retry-file", "Retry file", false, k, |s| {
                    s.open_file(s.file)
                })),
        )
    }
}

fn view(s: &State, _: &mut Cx<State>) -> El {
    let mut k = Kit::neutral(true);
    k.c.bg_base = BG;
    k.c.layer_01 = PANEL;
    k.c.text_base = INK;
    let header = row()
        .key("app-header")
        .h(60.0)
        .w_full()
        .px(18.0)
        .gap(12.0)
        .items_center()
        .fill(PANEL)
        .child(label("duff", TextStyle::new(23.0, 600.0), INK))
        .child(
            TextInput::new(&s.destination)
                .placeholder("GitHub or Azure repository URL")
                .on_edit(|s: &mut State| &mut s.destination)
                .on_submit(|s: &mut State, _| s.list(false))
                .build(&k)
                .grow(1.0)
                .key("repository-url"),
        )
        .child(action(
            "load-repository",
            if s.busy { "Working…" } else { "Load PRs" },
            false,
            &k,
            |s| s.list(false),
        ))
        .child(action(
            "toggle-inbox",
            if s.inbox_open {
                "Hide inbox"
            } else {
                "Show inbox"
            },
            s.inbox_open,
            &k,
            |s| s.inbox_open = !s.inbox_open,
        ));
    let show_inbox = s.inbox_open || s.review.is_none();
    let mut body = row().grow(1.0).min_h(0.0).w_full();
    if show_inbox {
        body = body.child(inbox(s, &k, s.layout == 2));
    }
    if s.layout != 2 {
        body = body.child(file_rail(s, &k));
    }
    body = body.child(review(s, &k, s.layout == 2));
    let mut footer = row()
        .key("layout-switcher")
        .h(45.0)
        .w_full()
        .gap(7.0)
        .px(16.0)
        .items_center()
        .fill(PANEL);
    for (index, name) in ["Workbench", "Focus", "Inbox"].iter().enumerate() {
        footer = footer.child(action(
            format!("layout-{index}"),
            *name,
            s.layout == index,
            &k,
            move |s| {
                s.layout = index;
                s.inbox_open = index != 1;
            },
        ));
    }
    footer = footer.child(row().grow(1.0)).child(label(
        "RUNE NATIVE · EFFECT CORE · LOCAL PROTOTYPE",
        k.ty.ui,
        MUTED,
    ));
    col()
        .key("app")
        .w_full()
        .h_full()
        .fill(BG)
        .child(header)
        .child(line())
        .child(body)
        .child(line())
        .child(
            row()
                .key("status")
                .w_full()
                .px(16.0)
                .py(10.0)
                .child(label(&s.status, k.ty.ui, if s.error { AMBER } else { MUTED }).wrap()),
        )
        .child(footer)
}

fn main() {
    let spec = AppSpec {
        min_size: Some((1120.0, 700.0)),
        families: ("Inter", "ui-monospace, Inter"),
        setup: Some(|s: &mut State, wake| match Bridge::start(wake) {
            Ok(bridge) => {
                s.bridge = Some(bridge);
                s.request(json!({"op":"saved"}), "Loading saved reviews…");
            }
            Err(message) => {
                s.status = message;
                s.error = true;
            }
        }),
        poll: Some(|s: &mut State, _, _| {
            let reply = s
                .bridge
                .as_ref()
                .and_then(|bridge| bridge.replies.try_recv().ok());
            if let Some(reply) = reply {
                s.busy = false;
                match reply {
                    Ok(payload) => s.accept(payload),
                    Err(message) => {
                        s.status = message;
                        s.error = true;
                    }
                }
                true
            } else {
                false
            }
        }),
        on_key: Some(|s: &mut State, event: &KeyEvent, tx| s.diff.key(event, tx)),
        ..AppSpec::new(
            "Duff — Standalone review prototype",
            (1560.0, 960.0),
            init,
            view,
        )
    };
    App::new(spec).modifier_keys().run();
}
