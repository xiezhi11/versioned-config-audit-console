export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export interface SourcePos {
  offset: number;
  line: number;
  column: number;
}

export interface SourceRange {
  start: SourcePos;
  end: SourcePos;
  snippet: string;
}

export type StructuredKind = 'null' | 'scalar' | 'array' | 'object';

export interface StructuredField {
  id: string;
  key: string;
  occurrence: number;
  keyRange: SourceRange;
  value: StructuredNode;
}

export interface StructuredNode {
  kind: StructuredKind;
  value: JsonValue;
  path: (string | number)[];
  range: SourceRange;
  fields?: StructuredField[];
  items?: StructuredNode[];
  duplicateKey?: boolean;
}

export interface ParseIssue {
  code: 'syntax' | 'too-deep' | 'empty-array' | 'duplicate-key' | 'unsupported-alias';
  message: string;
  path: (string | number)[];
  range: SourceRange | null;
  severity: 'error' | 'warning';
}

export interface StructuredParseResult {
  ok: boolean;
  root: StructuredNode | null;
  issues: ParseIssue[];
}

export type Condition =
| { path: string; equals?: JsonValue; exists?: boolean; notEquals?: JsonValue }
| { all: Condition[] }
| { any: Condition[] }
| { not: Condition };

export type TransformName = string;

export type MigrationOp =
| { id: string; type: 'default'; path: string; value: JsonValue; when?: Condition }
| { id: string; type: 'rename'; from: string; to: string; when?: Condition }
| { id: string; type: 'set'; path: string; value: JsonValue; when?: Condition }
| {
    id: string;
    type: 'split';
    from: string;
    targets: { path: string; part: number | string }[];
    separator?: string;
    when?: Condition;
  }
| {
    id: string;
    type: 'merge';
    sources: string[];
    target: string;
    separator?: string;
    when?: Condition;
  }
| {
    id: string;
    type: 'custom';
    transform: TransformName;
    args?: Record<string, JsonValue>;
    reads: string[];
    writes: string[];
    when?: Condition;
  };

export interface MigrationRule {
  id: string;
  fromVersion: string;
  toVersion: string;
  description?: string;
  dependsOn?: string[];
  /** Paths understood by this version family; untouched leaves outside these are unknown. */
  knownPaths?: string[];
  ops: MigrationOp[];
}

export interface MigrationRuleSet {
  rules: MigrationRule[];
}

export type ChangeCategory = 'unknown' | 'missing' | 'overwrite' | 'rename' | 'split' | 'merge' | 'custom' | 'conflict';
export type ChangeStatus = 'pending' | 'accepted' | 'rejected' | 'conflict' | 'manual';

export interface ChangeRecord {
  id: string;
  category: ChangeCategory;
  path: string;
  oldValue: JsonValue;
  newValue: JsonValue;
  sourcePaths: string[];
  ruleId: string;
  opId: string;
  fromVersion: string;
  toVersion: string;
  status: ChangeStatus;
  reason: string;
  dependsOn: string[];
  branchKey: string;
  order: number;
}

export interface MigrationAudit {
  ok: boolean;
  startVersion: string;
  targetVersion: string;
  currentVersion: string;
  path: { from: string; to: string; ruleId: string }[];
  changes: ChangeRecord[];
  unknownPaths: string[];
  conflicts: ChangeRecord[];
  result: JsonValue;
  ruleFingerprint: string;
  reason?: string;
}

export type ReviewDecision = 'accepted' | 'rejected' | 'manual';

export interface ReviewState {
  decisions: Record<string, { decision: Exclude<ReviewDecision, 'manual'>; at: string; by: string; value?: JsonValue }>;
  manual: Record<string, { value: JsonValue; at: string; by: string }>;
  expanded: string[];
  filters: { query: string; status: 'all' | ChangeStatus | 'unknown'; category: 'all' | ChangeCategory; page: number; pageSize: number };
}

export interface HistoryEntry {
  id: string;
  at: string;
  by: string;
  phase: 'preflight' | 'confirm' | 'reject' | 'manual' | 'batch-confirm' | 'import' | 'failure';
  changeIds: string[];
  inputFingerprint: string;
  ruleFingerprint: string;
  resultFingerprint?: string;
  message: string;
}

export interface MigrationWorkspace {
  format: 'alertmanager-config-migration-workspace/v1';
  input: JsonValue;
  inputText: string;
  dataVersion: string;
  targetVersion: string;
  ruleFingerprint: string;
  audit: MigrationAudit;
  review: ReviewState;
  history: HistoryEntry[];
  summary: string;
  fingerprint: string;
}

export type CustomTransform = (
  values: Record<string, JsonValue>,
  args: Record<string, JsonValue>,
) => Record<string, JsonValue>;
export type TransformRegistry = Record<string, CustomTransform>;
