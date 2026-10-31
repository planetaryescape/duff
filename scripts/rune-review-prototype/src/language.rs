use std::time::{Duration, Instant};

use rune::{El, Key, KeyEvent, ScrollSpec, TextStyle, Tx, col, row};
use rune_kit::{
    Kit, Markdown,
    diff::{Side, SymbolPosition},
};
use serde_json::{Value, json};

use crate::bridge::{DefinitionTarget, Payload};
use crate::{AMBER, BG, BORDER, INK, MUTED, PANEL, State, action, label, line};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Point {
    side: Side,
    line: u32,
    character: u32,
}

impl Point {
    fn side_name(self) -> &'static str {
        if self.side == Side::Old { "old" } else { "new" }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Query {
    Enable,
    Hover,
    Definition,
}

pub struct Language {
    pub enabled: bool,
    pub message: String,
    pub trust_prompt: bool,
    pending: Option<(u64, Query)>,
    sources: [String; 2],
    point: Option<Point>,
    focus: Option<Point>,
    anchor: (f32, f32),
    due: Option<Instant>,
    leave: Option<Instant>,
    inside_card: bool,
    hover: Option<String>,
    hover_point: Option<Point>,
    targets: Vec<DefinitionTarget>,
    target: usize,
    peek: bool,
}

impl Default for Language {
    fn default() -> Self {
        Self {
            enabled: false,
            message: "Code intelligence is off".into(),
            trust_prompt: false,
            pending: None,
            sources: Default::default(),
            point: None,
            focus: None,
            anchor: (0.0, 0.0),
            due: None,
            leave: None,
            inside_card: false,
            hover: None,
            hover_point: None,
            targets: vec![],
            target: 0,
            peek: false,
        }
    }
}

impl State {
    fn language_send(&mut self, mut request: Value) -> Option<u64> {
        self.serial += 1;
        request["id"] = json!(self.serial);
        self.bridge
            .as_ref()
            .is_some_and(|bridge| bridge.send(request))
            .then_some(self.serial)
    }

    fn cancel_language_query(&mut self) {
        if let Some((request_id, _)) = self.language.pending.take() {
            self.language_send(json!({"op":"language-cancel", "requestId":request_id}));
        }
    }

    pub fn clear_language_file(&mut self) {
        if !matches!(self.language.pending, Some((_, Query::Enable))) {
            self.cancel_language_query();
        }
        self.language.sources = Default::default();
        self.language.point = None;
        self.language.focus = None;
        self.language.due = None;
        self.language.leave = None;
        self.language.inside_card = false;
        self.language.hover = None;
        self.language.hover_point = None;
        self.language.peek = false;
        self.language.targets.clear();
    }

    pub fn disable_language(&mut self) {
        self.cancel_language_query();
        if let Some(review) = &self.review {
            let session = review.session.clone();
            self.language_send(json!({"op":"language-disable", "session":session}));
        }
        let sources = std::mem::take(&mut self.language.sources);
        self.language = Language::default();
        self.language.sources = sources;
    }

    pub fn enable_language(&mut self) {
        let Some(review) = &self.review else {
            return;
        };
        let session = review.session.clone();
        self.language.trust_prompt = false;
        self.cancel_language_query();
        self.language.message =
            "Starting trusted TypeScript tooling for both pinned revisions…".into();
        self.language.pending = self
            .language_send(json!({"op":"language-enable", "session":session}))
            .map(|id| (id, Query::Enable));
        if self.language.pending.is_none() {
            self.language.message = "Language bridge unavailable. Retry when it is ready.".into();
        }
    }

    pub fn language_sources(&mut self, old: String, new: String) {
        self.language.sources = [old, new];
    }

    pub fn symbol_hover(&mut self, position: Option<SymbolPosition>, tx: &mut Tx) {
        if !self.language.enabled || self.language.peek {
            tx.live_only();
            return;
        }
        let point = position.and_then(|p| {
            let source = &self.language.sources[usize::from(p.side == Side::New)];
            let (line, character) = utf16_position(source, p.line, p.byte)?;
            self.language.anchor = (p.window_x, p.window_y);
            Some(Point {
                side: p.side,
                line,
                character,
            })
        });
        if point == self.language.point {
            tx.live_only();
            return;
        }
        self.language.point = point;
        if matches!(self.language.pending, Some((_, Query::Hover))) {
            self.cancel_language_query();
        }
        if point.is_some() {
            self.language.hover = None;
            self.language.inside_card = false;
            self.language.leave = None;
            self.language.due = Some(Instant::now() + Duration::from_millis(300));
            tx.wake_after(Duration::from_millis(310));
        } else {
            self.language.due = None;
            self.language.leave = Some(Instant::now() + Duration::from_millis(250));
            tx.wake_after(Duration::from_millis(260));
        }
    }

    pub fn symbol_press(&mut self, position: SymbolPosition, tx: &mut Tx) {
        let source = &self.language.sources[usize::from(position.side == Side::New)];
        if let Some((line, character)) = utf16_position(source, position.line, position.byte) {
            let point = Point {
                side: position.side,
                line,
                character,
            };
            self.language.focus = Some(point);
            self.language.point = Some(point);
            self.language.anchor = (position.window_x, position.window_y);
            if tx.mods().cmd && self.language.enabled {
                self.query_symbol(Query::Definition);
            } else {
                tx.live_only();
            }
        }
    }

    fn query_symbol(&mut self, kind: Query) {
        if !self.language.enabled || !self.loaded {
            return;
        }
        let point = if kind == Query::Definition {
            self.language.focus.or(self.language.point)
        } else {
            self.language.point
        };
        let Some(point) = point else {
            return;
        };
        let Some(review) = &self.review else {
            return;
        };
        let Some(file) = review.files.get(self.file) else {
            return;
        };
        let request = json!({"op": if kind == Query::Definition { "definition" } else { "hover" },
            "session":review.session,"path":file.path,"side":point.side_name(),"line":point.line,"character":point.character});
        self.cancel_language_query();
        self.language.due = None;
        if kind == Query::Definition {
            self.language.peek = true;
            self.language.targets.clear();
            self.language.target = 0;
            self.language.hover = None;
        }
        self.language.message = "Reading the pinned symbol…".into();
        self.language.pending = self.language_send(request).map(|id| (id, kind));
        if self.language.pending.is_none() {
            self.language.message = "Language bridge unavailable.".into();
        }
    }

    pub fn poll_language(&mut self, tx: &mut Tx) -> bool {
        let now = Instant::now();
        if self.language.due.is_some_and(|due| now >= due) {
            self.query_symbol(Query::Hover);
            return true;
        }
        if !self.language.inside_card && self.language.leave.is_some_and(|due| now >= due) {
            self.language.leave = None;
            return self.language.hover.take().is_some();
        }
        if self.language.due.is_some() || self.language.leave.is_some() {
            tx.wake_after(Duration::from_millis(60));
        }
        false
    }

    pub fn accept_language(&mut self, id: u64, payload: Result<Payload, String>) -> bool {
        let Some((expected, kind)) = self.language.pending else {
            return false;
        };
        if id != expected {
            return false;
        }
        self.language.pending = None;
        match payload {
            Ok(Payload::Language {
                session,
                state,
                message,
            }) if kind == Query::Enable
                && self.review.as_ref().is_some_and(|r| r.session == session) =>
            {
                self.language.enabled = matches!(state.as_str(), "ready" | "limited");
                self.language.message = message;
            }
            Ok(Payload::Hover {
                session,
                path,
                side,
                line,
                character,
                content,
                message,
            }) if kind == Query::Hover
                && self.matches_symbol(&session, &path, &side, Some((line, character))) =>
            {
                self.language.message = message;
                self.language.hover = (!content.is_empty()).then_some(content);
                self.language.hover_point = self.language.point;
            }
            Ok(Payload::Definition {
                session,
                path,
                side,
                targets,
                message,
            }) if kind == Query::Definition
                && self.matches_symbol(&session, &path, &side, None) =>
            {
                self.language.targets = targets.into_iter().take(8).collect();
                self.language.message = message;
            }
            Err(message) => {
                self.language.message = message;
            }
            _ => {
                self.language.message = "Language response no longer matches this view.".into();
            }
        }
        true
    }

    fn matches_symbol(
        &self,
        session: &str,
        path: &str,
        side: &str,
        position: Option<(u32, u32)>,
    ) -> bool {
        let point = self
            .language
            .focus
            .filter(|_| self.language.peek)
            .or(self.language.point);
        self.review.as_ref().is_some_and(|r| {
            r.session == session && r.files.get(self.file).is_some_and(|f| f.path == path)
        }) && point.is_some_and(|p| {
            p.side_name() == side && position.is_none_or(|at| at == (p.line, p.character))
        })
    }

    pub fn language_key(&mut self, event: &KeyEvent) -> bool {
        match event.key {
            Key::Escape
                if self.language.trust_prompt
                    || self.language.peek
                    || self.language.hover.is_some()
                    || self.language.pending.is_some() =>
            {
                self.cancel_language_query();
                self.language.trust_prompt = false;
                self.language.peek = false;
                self.language.hover = None;
                self.language.due = None;
                true
            }
            Key::Function(12) if self.language.enabled && !self.language.peek => {
                self.query_symbol(Query::Definition);
                true
            }
            Key::Text(ref text)
                if (self.language.peek || self.language.trust_prompt)
                    && ["j", "k", "[", "]"].contains(&text.as_str()) =>
            {
                true
            }
            _ => false,
        }
    }
}

pub fn overlay(s: &State, k: &Kit) -> Option<El> {
    let bounds = rune::memo::layout("app").unwrap_or([0.0, 0.0, 1560.0, 960.0]);
    let width = 560.0_f32.min(bounds[2] - 32.0);
    let card = col()
        .key("language-card")
        .w(width)
        .max_h((bounds[3] - 120.0).min(600.0))
        .padding(18.0)
        .gap(12.0)
        .radius(8.0)
        .fill(PANEL)
        .border(1.0, BORDER);
    if s.language.trust_prompt {
        return Some(card.absolute((bounds[2] - width) / 2.0, 130.0).role("dialog").label("Enable code intelligence")
            .child(label("Understand this pinned review", k.ty.ui_medium, INK))
            .child(label("Duff will start its trusted TypeScript tooling with your account privileges—not in an OS sandbox. It will read separate pinned source snapshots. No PR installs, scripts, plugins or automatic typing downloads. Missing dependencies mean limited results.", k.ty.ui, MUTED).wrap())
            .child(row().gap(8.0).child(action("language-confirm", "Enable for this review", true, k, State::enable_language)).child(action("language-cancel-trust", "Cancel", false, k, |s| s.language.trust_prompt = false))));
    }
    if s.language.peek {
        let mut content = card
            .absolute((bounds[2] - width).max(16.0) - 16.0, 120.0)
            .role("dialog")
            .label("Read-only definition peek")
            .child(
                row()
                    .child(label("DEFINITION · READ ONLY", k.ty.ui_medium, AMBER))
                    .child(row().grow(1.0))
                    .child(action("definition-back", "Back · Esc", false, k, |s| {
                        s.cancel_language_query();
                        s.language.peek = false;
                    })),
            );
        if s.language.targets.len() > 1 {
            let mut choices = row().gap(6.0);
            for (index, _) in s.language.targets.iter().enumerate() {
                choices = choices.child(action(
                    format!("definition-target-{index}"),
                    format!("{}", index + 1),
                    index == s.language.target,
                    k,
                    move |s| s.language.target = index,
                ));
            }
            content = content.child(choices);
        }
        if let Some(target) = s.language.targets.get(s.language.target) {
            content = content
                .child(
                    label(
                        format!(
                            "{}:{}:{} · {}",
                            target.path,
                            target.line + 1,
                            target.character + 1,
                            &target.commit[..target.commit.len().min(10)]
                        ),
                        k.ty.ui,
                        INK,
                    )
                    .wrap(),
                )
                .child(line());
            let mut lines = col().w_full().gap(2.0);
            for (offset, text) in target.text.lines().enumerate() {
                let number = target.start_line as usize + offset;
                lines = lines.child(
                    row()
                        .w_full()
                        .gap(10.0)
                        .fill(if number == target.line as usize {
                            BORDER
                        } else {
                            BG
                        })
                        .child(label(format!("{:>4}", number + 1), k.ty.small, MUTED))
                        .child(
                            label(text, TextStyle::new(12.0, 400.0).mono().lh(18.0), INK)
                                .selectable(true)
                                .wrap()
                                .grow(1.0)
                                .min_w(0.0),
                        ),
                );
            }
            content = content.child(
                col()
                    .h((target.text.lines().count().max(3) as f32 * 20.0).min(360.0))
                    .max_h((bounds[3] - 360.0).max(60.0))
                    .scroll(ScrollSpec {
                        stick_bottom: false,
                    })
                    .child(lines),
            );
        }
        return Some(content.child(label(&s.language.message, k.ty.small, MUTED).wrap()));
    }
    let hover = s.language.hover.as_ref()?;
    let x = s
        .language
        .anchor
        .0
        .clamp(16.0, (bounds[2] - width - 16.0).max(16.0));
    let y = (s.language.anchor.1 + 20.0).clamp(70.0, (bounds[3] - 440.0).max(70.0));
    let point = s.language.hover_point;
    let revision = point.and_then(|p| {
        s.review.as_ref().map(|r| {
            if p.side == Side::Old {
                &r.base
            } else {
                &r.head
            }
        })
    });
    Some(
        card.absolute(x, y)
            .max_h((bounds[3] - y - 16.0).min(400.0))
            .role("dialog")
            .label("Symbol information")
            .on_hover_change(|s: &mut State, inside, tx| {
                s.language.inside_card = inside;
                if !inside {
                    s.language.leave = Some(Instant::now() + Duration::from_millis(250));
                    tx.wake_after(Duration::from_millis(260));
                }
            })
            .child(
                row()
                    .gap(8.0)
                    .child(label(
                        format!(
                            "{} · {}",
                            point.map_or("", Point::side_name),
                            revision.map_or("", |r| &r[..r.len().min(10)])
                        ),
                        k.ty.small,
                        AMBER,
                    ))
                    .child(row().grow(1.0))
                    .child(action("hover-dismiss", "Esc", false, k, |s| {
                        s.cancel_language_query();
                        s.language.hover = None;
                    })),
            )
            .child(
                col()
                    .max_h(280.0)
                    .min_h(0.0)
                    .scroll(ScrollSpec {
                        stick_bottom: false,
                    })
                    .child(Markdown::new(hover).build(k)),
            )
            .child(label(
                "Limited source context · no dependency install",
                k.ty.small,
                MUTED,
            ))
            .child(action(
                "hover-definition",
                "Peek definition · F12",
                false,
                k,
                |s| {
                    s.language.focus = s.language.hover_point;
                    s.query_symbol(Query::Definition);
                },
            )),
    )
}

pub fn utf16_position(source: &str, line: u32, byte: usize) -> Option<(u32, u32)> {
    let index = line.checked_sub(1)?;
    let text = source.split('\n').nth(index as usize)?;
    let text = text.strip_suffix('\r').unwrap_or(text);
    let prefix = text.get(..byte)?;
    Some((index, prefix.encode_utf16().count().try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::utf16_position;

    #[test]
    fn native_source_bytes_map_to_original_lsp_positions_not_visual_columns() {
        let source = "a\r\n\tconst 名 = \"😀\"; chosen";
        assert_eq!(utf16_position(source, 2, 21), Some((1, 17)));
        assert_eq!(utf16_position(source, 2, 15), None);
        assert_eq!(utf16_position(source, 0, 0), None);
        assert_eq!(utf16_position(source, 3, 0), None);
    }
}
