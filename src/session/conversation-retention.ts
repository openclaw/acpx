import type {
  SessionAgentContent,
  SessionAgentMessage,
  SessionConversation,
  SessionMessage,
  SessionToolResult,
  SessionUserContent,
} from "../types.js";
import { isAgentMessage, isUserMessage } from "./conversation-reducer.js";

const MAX_RUNTIME_MESSAGES = 200;
const MAX_RUNTIME_AGENT_TEXT_CHARS = 8_000;
const MAX_RUNTIME_THINKING_CHARS = 4_000;
const MAX_RUNTIME_TOOL_IO_CHARS = 4_000;
const MAX_RUNTIME_REQUEST_TOKEN_USAGE = 100;

function trimRuntimeText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  let end = Math.max(0, maxChars - 3);
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return `${value.slice(0, end)}...`;
}

export function trimConversationForRuntime(conversation: SessionConversation): void {
  if (conversation.messages.length > MAX_RUNTIME_MESSAGES) {
    conversation.messages = conversation.messages.slice(-MAX_RUNTIME_MESSAGES);
  }

  for (const message of conversation.messages) {
    trimRuntimeMessage(message);
  }

  const requestUsageEntries = Object.entries(conversation.request_token_usage);
  if (requestUsageEntries.length > MAX_RUNTIME_REQUEST_TOKEN_USAGE) {
    conversation.request_token_usage = Object.fromEntries(
      requestUsageEntries.slice(-MAX_RUNTIME_REQUEST_TOKEN_USAGE),
    );
  }
}

function trimRuntimeMessage(message: SessionMessage): void {
  if (isUserMessage(message)) {
    trimRuntimeUserMessage(message.User);
    return;
  }

  if (isAgentMessage(message)) {
    trimRuntimeAgentMessage(message.Agent);
  }
}

function trimRuntimeUserMessage(message: { content: SessionUserContent[] }): void {
  message.content = message.content.map((content) => {
    if ("Text" in content) {
      return {
        Text: trimRuntimeText(content.Text, MAX_RUNTIME_AGENT_TEXT_CHARS),
      };
    }
    return content;
  });
}

function trimRuntimeAgentMessage(message: SessionAgentMessage): void {
  for (const content of message.content) {
    trimRuntimeAgentContent(content);
  }

  for (const result of Object.values(message.tool_results)) {
    trimRuntimeToolResult(result);
  }
}

function trimRuntimeAgentContent(content: SessionAgentContent): void {
  if ("Text" in content) {
    content.Text = trimRuntimeText(content.Text, MAX_RUNTIME_AGENT_TEXT_CHARS);
  } else if ("Thinking" in content) {
    content.Thinking.text = trimRuntimeText(content.Thinking.text, MAX_RUNTIME_THINKING_CHARS);
  } else if ("ToolUse" in content) {
    content.ToolUse.raw_input = trimRuntimeText(
      content.ToolUse.raw_input,
      MAX_RUNTIME_TOOL_IO_CHARS,
    );
  }
}

function trimRuntimeToolResult(result: SessionToolResult): void {
  if ("Text" in result.content) {
    result.content.Text = trimRuntimeText(result.content.Text, MAX_RUNTIME_TOOL_IO_CHARS);
  }
  if (typeof result.output === "string") {
    result.output = trimRuntimeText(result.output, MAX_RUNTIME_TOOL_IO_CHARS);
  }
}
