# Zed Thread Schema Reference

This document describes Zed's persisted thread schema as implemented in Zed commit:

- `511be9a3ffa032da6bab82ddfdd2e492c68298e3`

Source files used:

- `crates/agent/src/db.rs`
- `crates/agent/src/thread.rs`
- `crates/acp_thread/src/connection.rs`
- `crates/acp_thread/src/mention.rs`
- `crates/language_model/src/language_model.rs`
- `crates/language_model/src/request.rs`

## 1. Storage Layout

Zed stores threads in SQLite table `threads` with metadata columns and a serialized payload blob:

- `id TEXT PRIMARY KEY`
- `parent_id TEXT` (added by migration; set from subagent context)
- `folder_paths TEXT`
- `folder_paths_order TEXT`
- `summary TEXT NOT NULL`
- `updated_at TEXT NOT NULL` (RFC3339)
- `data_type TEXT NOT NULL` (`"json"` or `"zstd"`)
- `data BLOB NOT NULL`

Current writes use:

- `data_type = "zstd"`
- `data = zstd(level=3, utf8_json)`

Notes:

- Reads support both `json` and `zstd` blobs.
- `summary`/`updated_at` are duplicated in both columns and payload JSON.

## 2. Persisted JSON Envelope

The blob JSON is not raw `DbThread`; Zed wraps it with a top-level `version` field via a flattened wrapper.

Canonical shape written today:

```json
{
  "title": "...",
  "messages": [...],
  "updated_at": "2026-02-27T12:34:56Z",
  "detailed_summary": null,
  "initial_project_snapshot": null,
  "cumulative_token_usage": {...},
  "request_token_usage": {...},
  "model": null,
  "profile": null,
  "imported": false,
  "subagent_context": null,
  "speed": null,
  "thinking_enabled": false,
  "thinking_effort": null,
  "version": "0.3.0"
}
```

Version handling:

- `DbThread::VERSION = "0.3.0"`.
- On load, if `version` is missing or not `0.3.0`, Zed attempts legacy upgrade (`upgrade_from_agent_1`).

## 3. DbThread Fields (Exact)

`DbThread` fields:

- `title: SharedString`
- `messages: Vec<Message>`
- `updated_at: DateTime<Utc>`
- `detailed_summary: Option<SharedString>` (`#[serde(default)]`)
- `initial_project_snapshot: Option<ProjectSnapshot>` (`#[serde(default)]`)
- `cumulative_token_usage: TokenUsage` (`#[serde(default)]`)
- `request_token_usage: HashMap<UserMessageId, TokenUsage>` (`#[serde(default)]`)
- `model: Option<SerializedLanguageModel>` (`#[serde(default)]`)
- `profile: Option<AgentProfileId>` (`#[serde(default)]`)
- `imported: bool` (`#[serde(default)]`)
- `subagent_context: Option<SubagentContext>` (`#[serde(default)]`)
- `speed: Option<Speed>` (`#[serde(default)]`)
- `thinking_enabled: bool` (`#[serde(default)]`)
- `thinking_effort: Option<String>` (`#[serde(default)]`)

Important defaults:

- Missing defaulted fields deserialize cleanly.
- `imported` defaults to `false`.
- `subagent_context` defaults to `null`/`None`.

## 4. Message Schema

`Message` enum variants:

- `User(UserMessage)`
- `Agent(AgentMessage)`
- `Resume`

Because serde default enum tagging is used (externally tagged):

- `User` serializes as `{ "User": { ... } }`
- `Agent` serializes as `{ "Agent": { ... } }`
- Unit variant `Resume` serializes as string: `"Resume"`

### 4.1 UserMessage

Fields:

- `id: UserMessageId` (newtype string)
- `content: Vec<UserMessageContent>`

`UserMessageContent` variants:

- `Text(String)`
- `Mention { uri: MentionUri, content: String }`
- `Image(LanguageModelImage)`

### 4.2 AgentMessage

Fields:

- `content: Vec<AgentMessageContent>`
- `tool_results: IndexMap<LanguageModelToolUseId, LanguageModelToolResult>`
- `reasoning_details: Option<serde_json::Value>`

`AgentMessageContent` variants:

- `Text(String)`
- `Thinking { text: String, signature: Option<String> }`
- `RedactedThinking(String)`
- `ToolUse(LanguageModelToolUse)`

## 5. MentionUri Schema

`MentionUri` variants used inside `UserMessageContent::Mention.uri`:

- `File { abs_path: PathBuf }`
- `PastedImage`
- `Directory { abs_path: PathBuf }`
- `Symbol { abs_path: PathBuf, name: String, line_range: RangeInclusive<u32> }`
- `Thread { id: SessionId, name: String }`
- `TextThread { path: PathBuf, name: String }`
- `Rule { id: PromptId, name: String }`
- `Diagnostics { include_errors: bool, include_warnings: bool }`
- `Selection { abs_path: Option<PathBuf>, line_range: RangeInclusive<u32> }`
- `Fetch { url: Url }`
- `TerminalSelection { line_count: u32 }`
- `GitDiff { base_ref: String }`

Idiosyncrasies:

- `Diagnostics.include_errors` defaults `true` when absent.
- `Diagnostics.include_warnings` defaults `false` when absent.
- `Selection.abs_path` is omitted when `None` due `skip_serializing_if`.

## 6. Tool and Usage Schema

### 6.1 TokenUsage

`TokenUsage` fields:

- `input_tokens: u64`
- `output_tokens: u64`
- `cache_creation_input_tokens: u64`
- `cache_read_input_tokens: u64`

Each field has:

- `#[serde(default)]`
- `#[serde(skip_serializing_if = "is_default")]`

So zero values are often omitted from stored JSON.

### 6.2 LanguageModelToolUse

Fields:

- `id: LanguageModelToolUseId` (newtype string)
- `name: Arc<str>`
- `raw_input: String`
- `input: serde_json::Value`
- `is_input_complete: bool`
- `thought_signature: Option<String>`

### 6.3 LanguageModelToolResult

Fields:

- `tool_use_id: LanguageModelToolUseId`
- `tool_name: Arc<str>`
- `is_error: bool`
- `content: LanguageModelToolResultContent`
- `output: Option<serde_json::Value>`

`LanguageModelToolResultContent` canonical serialized variants:

- `Text(Arc<str>)`
- `Image(LanguageModelImage)`

Deserializer is intentionally permissive and accepts multiple forms:

- Plain string (`"..."`) -> `Text`
- Wrapped text object (`{"type":"text","text":"..."}`), case-insensitive key matching
- Single-key wrapped enum style (`{"text":"..."}` or case variants)
- Wrapped image (`{"image": {...}}`) with case-insensitive key matching
- Direct image object with case-insensitive `source`/`size`/`width`/`height`

Serialization remains canonical enum serialization; deserialization accepts broader shapes.

### 6.4 Speed

`Speed` enum uses `#[serde(rename_all = "snake_case")]`:

- `Standard` <-> `"standard"`
- `Fast` <-> `"fast"`

## 7. ID Types and Wire Behavior

Types used in persisted payload:

- `SessionId` (ACP thread/session id)
- `UserMessageId`
- `LanguageModelToolUseId`

All three are newtype wrappers and serialize as strings in JSON.

`UserMessageId` generation:

- UUID v4 string when created in Zed (`UserMessageId::new()`).

## 8. Metadata vs Payload Split

`DbThreadMetadata` (used by list API) is derived from SQLite columns, not blob decode.

Fields:

- `id`
- `parent_session_id`
- `title`
- `updated_at`
- `folder_paths`

Idiosyncrasy:

- `title` has `#[serde(alias = "summary")]` for compatibility with prior serialized naming.

## 9. Legacy Upgrade Idiosyncrasies

When upgrading old thread format:

- Legacy system-role messages are dropped.
- Old user message IDs are not preserved; fresh `UserMessageId` values are generated.
- Tool-use `raw_input` is reconstructed via `serde_json::to_string(input)`.
- If tool result name lookup fails, tool name is set to `"unknown"`.
- Per-request token usage is remapped to regenerated user message IDs.

These are semantic transforms, not byte-preserving migrations.

## 10. SharedThread (Export/Import) Schema

Zed also defines `SharedThread` (separate from normal `DbThread` persistence):

Fields:

- `title`
- `messages`
- `updated_at`
- `model`
- `version` (`"1.0.0"`)

Encoding:

- serialized to JSON, then zstd-compressed

Import behavior into `DbThread`:

- title is prefixed with `"🔗 "`
- `imported = true`
- several fields reset/defaulted (`detailed_summary`, token usage, profile, subagent context, speed, thinking fields)

## 11. Non-Obvious Serde Behaviors (Important)

- Enum representation is default externally tagged everywhere unless explicit serde attributes override it.
- Unit enum variants become bare strings (for example `"Resume"`).
- Most structs do not use `deny_unknown_fields`; extra unknown keys are generally ignored.
- Many optional/default fields deserialize even when absent, so sparse payloads are accepted.

## 12. Scope and Accuracy Notes

This reference is exact for the pinned commit above. It is not a protocol spec for all Zed versions.
If Zed changes serde attributes, enum variants, or wrapper/version logic, this document must be re-audited against source.
