/**
 * A registry of every schema this package exports.
 *
 * Two jobs:
 *
 *  1. The JSON Schema round-trip test iterates this object, so the
 *     "every schema converts" guarantee cannot quietly stop covering a schema
 *     someone added later — a new export with no registry entry fails the
 *     completeness assertion below it.
 *  2. `@ghostai/server` feeds it to `@fastify/swagger` as the `$defs` pool for
 *     the generated OpenAPI 3.1 document.
 */

import type { z } from 'zod';

import * as automation from './automation.js';
import * as config from './config.js';
import * as messages from './messages.js';
import * as rest from './rest.js';
import * as tools from './tools.js';
import * as ws from './ws.js';

export const PROTOCOL_SCHEMAS = {
  // messages
  ChatRole: messages.ChatRoleSchema,
  TextPart: messages.TextPartSchema,
  ImagePart: messages.ImagePartSchema,
  ContentPart: messages.ContentPartSchema,
  ToolCall: messages.ToolCallSchema,
  SystemMessage: messages.SystemMessageSchema,
  UserMessage: messages.UserMessageSchema,
  AssistantMessage: messages.AssistantMessageSchema,
  ToolMessage: messages.ToolMessageSchema,
  ChatMessage: messages.ChatMessageSchema,
  StoredMessage: messages.StoredMessageSchema,
  Usage: messages.UsageSchema,
  StopReason: messages.StopReasonSchema,

  // tools
  ToolRisk: tools.ToolRiskSchema,
  ToolApprovalPolicy: tools.ToolApprovalPolicySchema,
  ToolSource: tools.ToolSourceSchema,
  ToolAnnotations: tools.ToolAnnotationsSchema,
  ToolDefinition: tools.ToolDefinitionSchema,
  ApprovalScope: tools.ApprovalScopeSchema,

  // config
  ReasoningEffort: config.ReasoningEffortSchema,
  AgentDefaults: config.AgentDefaultsSchema,
  AgentsConfig: config.AgentsConfigSchema,
  ProviderConfig: config.ProviderConfigSchema,
  ProvidersConfig: config.ProvidersConfigSchema,
  AuthConfig: config.AuthConfigSchema,
  ServerConfig: config.ServerConfigSchema,
  WebSearchConfig: config.WebSearchConfigSchema,
  WebToolsConfig: config.WebToolsConfigSchema,
  ExecToolConfig: config.ExecToolConfigSchema,
  McpOAuthConfig: config.McpOAuthConfigSchema,
  McpTransport: config.McpTransportSchema,
  McpServerConfig: config.McpServerConfigSchema,
  ToolApprovalsConfig: config.ToolApprovalsConfigSchema,
  ToolsConfig: config.ToolsConfigSchema,
  AudioConfig: config.AudioConfigSchema,
  RagConfig: config.RagConfigSchema,
  HeartbeatConfig: config.HeartbeatConfigSchema,
  SchedulerConfig: config.SchedulerConfigSchema,
  ChannelsConfig: config.ChannelsConfigSchema,
  PluginsConfig: config.PluginsConfigSchema,
  Config: config.ConfigSchema,
  ConfigPatch: config.ConfigPatchSchema,

  // automation
  AtSchedule: automation.AtScheduleSchema,
  EverySchedule: automation.EveryScheduleSchema,
  CronSchedule: automation.CronScheduleSchema,
  AutomationSchedule: automation.AutomationScheduleSchema,
  AutomationDelivery: automation.AutomationDeliverySchema,
  ScheduledPayload: automation.ScheduledPayloadSchema,
  HeartbeatPayload: automation.HeartbeatPayloadSchema,
  AutomationPayload: automation.AutomationPayloadSchema,
  RunStatus: automation.RunStatusSchema,
  AutomationJobState: automation.AutomationJobStateSchema,
  AutomationJob: automation.AutomationJobSchema,
  AutomationRun: automation.AutomationRunSchema,
  CreateAutomationJob: automation.CreateAutomationJobSchema,
  UpdateAutomationJob: automation.UpdateAutomationJobSchema,

  // websocket — client
  Attachment: ws.AttachmentSchema,
  PingMessage: ws.PingMessageSchema,
  UserMessageRequest: ws.UserMessageRequestSchema,
  StopTurnMessage: ws.StopTurnMessageSchema,
  NewSessionMessage: ws.NewSessionMessageSchema,
  SwitchSessionMessage: ws.SwitchSessionMessageSchema,
  ResumeSessionMessage: ws.ResumeSessionMessageSchema,
  ToolApproveMessage: ws.ToolApproveMessageSchema,
  TranscribeMessage: ws.TranscribeMessageSchema,
  SteerMessage: ws.SteerMessageSchema,
  ClientMessage: ws.ClientMessageSchema,

  // websocket — server
  ConnectedEvent: ws.ConnectedEventSchema,
  PongEvent: ws.PongEventSchema,
  ErrorCode: ws.ErrorCodeSchema,
  ErrorEvent: ws.ErrorEventSchema,
  MessageAckEvent: ws.MessageAckEventSchema,
  MessageQueuedEvent: ws.MessageQueuedEventSchema,
  TurnStartEvent: ws.TurnStartEventSchema,
  AssistantDeltaEvent: ws.AssistantDeltaEventSchema,
  ReasoningDeltaEvent: ws.ReasoningDeltaEventSchema,
  ToolCallEvent: ws.ToolCallEventSchema,
  ToolProgressEvent: ws.ToolProgressEventSchema,
  ToolResultEvent: ws.ToolResultEventSchema,
  ToolApprovalRequestEvent: ws.ToolApprovalRequestEventSchema,
  NoticeKind: ws.NoticeKindSchema,
  NoticeEvent: ws.NoticeEventSchema,
  TurnEndEvent: ws.TurnEndEventSchema,
  SessionStatusEvent: ws.SessionStatusEventSchema,
  SessionResetEvent: ws.SessionResetEventSchema,
  SessionReplayEvent: ws.SessionReplayEventSchema,
  NotificationEvent: ws.NotificationEventSchema,
  TranscribeResultEvent: ws.TranscribeResultEventSchema,
  ToolsChangedEvent: ws.ToolsChangedEventSchema,
  SteerEvent: ws.SteerEventSchema,
  ServerMessage: ws.ServerMessageSchema,

  // rest
  ErrorResponse: rest.ErrorResponseSchema,
  PaginationQuery: rest.PaginationQuerySchema,
  StatusResponse: rest.StatusResponseSchema,
  HealthCheck: rest.HealthCheckSchema,
  HealthResponse: rest.HealthResponseSchema,
  SettingsResponse: rest.SettingsResponseSchema,
  SetCredentialRequest: rest.SetCredentialRequestSchema,
  ProviderInfo: rest.ProviderInfoSchema,
  ProviderInstanceInfo: rest.ProviderInstanceInfoSchema,
  ProvidersResponse: rest.ProvidersResponseSchema,
  ModelInfo: rest.ModelInfoSchema,
  ModelsResponse: rest.ModelsResponseSchema,
  SessionSummary: rest.SessionSummarySchema,
  SessionListResponse: rest.SessionListResponseSchema,
  SessionMessagesResponse: rest.SessionMessagesResponseSchema,
  CreateSessionRequest: rest.CreateSessionRequestSchema,
  UpdateSessionRequest: rest.UpdateSessionRequestSchema,
  ContextResponse: rest.ContextResponseSchema,
  ToolListResponse: rest.ToolListResponseSchema,
  FileEntry: rest.FileEntrySchema,
  FileListResponse: rest.FileListResponseSchema,
  SignedUrl: rest.SignedUrlSchema,
  SignedUrlRequest: rest.SignedUrlRequestSchema,
  UploadResponse: rest.UploadResponseSchema,
  FileTextResponse: rest.FileTextResponseSchema,
  FileWriteRequest: rest.FileWriteRequestSchema,
  CreateDirectoryRequest: rest.CreateDirectoryRequestSchema,
  WorkspaceSummary: rest.WorkspaceSummarySchema,
  WorkspaceListResponse: rest.WorkspaceListResponseSchema,
  CreateWorkspaceRequest: rest.CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequest: rest.UpdateWorkspaceRequestSchema,
  MoveSessionsRequest: rest.MoveSessionsRequestSchema,
  MoveSessionsResponse: rest.MoveSessionsResponseSchema,
  Notification: rest.NotificationSchema,
  NotificationListResponse: rest.NotificationListResponseSchema,
  AutomationJobListResponse: rest.AutomationJobListResponseSchema,
  AutomationRunListResponse: rest.AutomationRunListResponseSchema,
  LoginRequest: rest.LoginRequestSchema,
  LoginResponse: rest.LoginResponseSchema,
  AuthSessionResponse: rest.AuthSessionResponseSchema,
  SetupStatusResponse: rest.SetupStatusResponseSchema,
  SetupClaimRequest: rest.SetupClaimRequestSchema,
  SetupPasswordRequest: rest.SetupPasswordRequestSchema,
} satisfies Record<string, z.ZodType>;

export type ProtocolSchemaName = keyof typeof PROTOCOL_SCHEMAS;

/** The modules the completeness test reflects over to catch unregistered exports. */
export const SCHEMA_MODULES = { automation, config, messages, rest, tools, ws };
