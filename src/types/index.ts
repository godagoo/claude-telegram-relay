/**
 * Centralized type exports
 */

export type { AppConfig, ClaudeCallOptions } from "./config";
export type { SessionState, SessionManager } from "./session";
export type {
  Memory,
  Goal,
  CompletedGoal,
  DetectedIntents,
  MemoryService,
} from "./memory";
export type {
  Category,
  Classification,
  ExtractedData,
  PeopleData,
  ProjectsData,
  IdeasData,
  AdminData,
  CaptureResult,
  ScannedDocument,
  CaptureStats,
  WeeklySummary,
  FixResult,
  SecondBrainConfig,
  FrontmatterResult,
} from "./secondbrain";
export { VALID_CATEGORIES } from "./secondbrain";
export type {
  FilesConfig,
  FileEntry,
  FileContent,
  SearchResult,
  ShareDiff,
  WatcherCallbacks,
} from "./files";
export { FileAccessError } from "./files";
export type { FileAccessErrorCode } from "./files";
