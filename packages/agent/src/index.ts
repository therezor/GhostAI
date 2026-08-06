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
  AgentEvent,
  AgentEventType,
  AssistantDeltaEvent,
  NestedAgentEvent,
  NoticeEvent,
  ReasoningDeltaEvent,
  SubagentEvent,
  ToolApprovalRequestEvent,
  ToolCallEvent,
  ToolProgressEvent,
  ToolResultEvent,
  TurnEndEvent,
  TurnStartEvent,
} from './events.js';

export {
  MAX_SUBAGENT_DEPTH,
  refuseDelegation,
  subagentDefinition,
  subagentMap,
  subagentResult,
  type SubagentBinding,
} from './subagent.js';

export {
  deniedNotice,
  deniedToolResult,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
  type DenialReason,
} from './approval.js';

export {
  MAX_INLINE_TEXT_BYTES,
  materialiseAttachments,
  materialiseFilePart,
  type AttachmentCache,
} from './attachments.js';

export {
  SECTION_SEPARATOR,
  type PromptToolbox,
  buildRuntimeBlock,
  buildStaticPrompt,
  type BuildRuntimeBlockOptions,
  type BuildStaticPromptOptions,
  type ContextContributor,
  type PromptAgent,
  type RuntimePromptContext,
  type StaticPromptContext,
} from './prompt.js';

export {
  MAX_DESCRIPTION_CHARS,
  MAX_SKILLS,
  SKILLS_DIRNAME,
  SKILL_FILENAME,
  SKILL_MAX_BYTES,
  readSkills,
  type Skill,
} from './skills.js';

export { SkillsContributor, renderSkills } from './skills-contributor.js';

export {
  MemoryContributor,
  renderMemorySection,
} from './memory-contributor.js';

export {
  MAX_PENDING_STEER,
  STEERING_PREFIX,
  SteeringQueue,
  steeringText,
} from './steering.js';

export { describeContext, type ContextReport } from './context.js';

export { CANCELLED_TOOL_RESULT, TOOL_HEARTBEAT_MS } from './dispatch.js';

export {
  AgentLoop,
  type AgentLoopOptions,
  type PromptPreview,
  type PromptPreviewInput,
  type TurnInput,
  type TurnResult,
} from './loop.js';
