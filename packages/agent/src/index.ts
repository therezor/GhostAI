/**
 * @ghostai/agent — the loop.
 *
 * This package turns a provider, a tool registry and a session store into a
 * turn: an async generator of `AgentEvent`s that a terminal renderer, a
 * WebSocket hub or a Telegram channel all consume the same way. Every transport
 * above it is a projection of that one event stream, which is why there is no
 * `onToken` callback and no transport-shaped variant of the loop.
 *
 * **This package must never import `@ghostai/server`.** The Python original
 * imported its web-layer agent manager from inside the agent loop; that cycle
 * is prevented here by the dependency direction, and the layering lint rule
 * exists to keep it prevented.
 */

export type {
  AgentErrorEvent,
  AgentEvent,
  AgentEventType,
  AssistantDeltaEvent,
  NoticeEvent,
  ReasoningDeltaEvent,
  ToolApprovalRequestEvent,
  ToolCallEvent,
  ToolProgressEvent,
  ToolResultEvent,
  TurnEndEvent,
  TurnStartEvent,
} from './events.js';

export {
  deniedNotice,
  deniedToolResult,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
  type DenialReason,
} from './approval.js';

export {
  SECTION_SEPARATOR,
  buildRuntimeBlock,
  buildStaticPrompt,
  composeSystemPrompt,
  type BuildRuntimeBlockOptions,
  type BuildStaticPromptOptions,
  type ContextContributor,
  type RuntimePromptContext,
  type StaticPromptContext,
} from './prompt.js';

export {
  MAX_PENDING_STEER,
  STEERING_PREFIX,
  SteeringQueue,
  steeringText,
  type SteeringMessage,
  type SteeringQueueOptions,
} from './steering.js';

export {
  describeContext,
  type ContextBreakdown,
  type ContextReport,
  type DescribeContextInput,
} from './context.js';

export {
  AgentLoop,
  CANCELLED_TOOL_RESULT,
  TOOL_HEARTBEAT_MS,
  type AgentLoopOptions,
  type PromptPreviewInput,
  type TurnInput,
  type TurnResult,
} from './loop.js';
