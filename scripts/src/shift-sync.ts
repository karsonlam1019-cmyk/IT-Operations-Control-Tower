export type ShiftField =
  | "staffMember"
  | "team"
  | "region"
  | "environment"
  | "signal"
  | "action"
  | "processStatus"
  | "priority"
  | "dueDate";

export type ShiftMapping = {
  identifier: {
    supabaseColumn: string;
    jiraField: "id" | "key";
  };
  fields: Record<ShiftField, { supabaseColumn: string; jiraField: string }>;
  updatedAt: {
    supabaseColumn: string;
    jiraField: string;
  };
};

export type NormalizedShift = {
  identifier: string;
  staffMember: string;
  team: string;
  region: string;
  environment: string;
  signal: string;
  action: string;
  processStatus: string;
  priority: string;
  dueDate: string;
  updatedAt: string;
};

export type NormalizationIssue = {
  source: "jira" | "supabase";
  index: number;
  code:
    | "missing_identifier"
    | "missing_staff_member"
    | "missing_team"
    | "missing_region"
    | "missing_environment"
    | "missing_signal"
    | "missing_action"
    | "missing_process_status"
    | "missing_priority"
    | "missing_due_date"
    | "missing_updated_at"
    | "invalid_updated_at"
    | "invalid_record";
};

export type NormalizationResult = {
  sourceCount: number;
  records: NormalizedShift[];
  missingStableIdentifiers: number;
  duplicateIdentifiers: string[];
  issues: NormalizationIssue[];
};

export type FieldMismatch = {
  identifier: string;
  field: ShiftField;
  jiraValue: string;
  supabaseValue: string;
};

export type TimestampMismatch = {
  identifier: string;
  jiraUpdatedAt: string;
  supabaseUpdatedAt: string;
  staleSide: "jira" | "supabase";
};

export type ReconciliationReport = {
  status: "PASS" | "EMPTY_REACHABLE" | "MISMATCH";
  jiraCount: number;
  supabaseCount: number;
  matchedCount: number;
  jiraOnly: string[];
  supabaseOnly: string[];
  duplicateIdentifiers: {
    jira: string[];
    supabase: string[];
  };
  missingStableIdentifiers: {
    jira: number;
    supabase: number;
  };
  malformedRecords: {
    jira: number;
    supabase: number;
  };
  fieldMismatches: FieldMismatch[];
  timestampMismatches: TimestampMismatch[];
  staleUpdates: TimestampMismatch[];
};

type JsonRecord = Record<string, unknown>;

export const SHIFT_FIELDS: ShiftField[] = [
  "staffMember",
  "team",
  "region",
  "environment",
  "signal",
  "action",
  "processStatus",
  "priority",
  "dueDate",
];

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    const record = asRecord(current);
    return record ? record[segment] : undefined;
  }, value);
}

export function readJiraValue(issue: unknown, field: string): unknown {
  const record = asRecord(issue);
  if (!record) return undefined;
  if (field === "id" || field === "key") return record[field];
  return readPath(asRecord(record.fields), field);
}

export function sourceValueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  const record = asRecord(value);
  if (record) {
    for (const key of ["displayName", "name", "emailAddress", "accountId", "value"]) {
      if (typeof record[key] === "string" || typeof record[key] === "number") {
        return String(record[key]).trim();
      }
    }
  }
  return "";
}

function comparableText(value: unknown): string {
  return sourceValueText(value).replace(/\s+/g, " ").toLowerCase();
}

export function normalizeTimestamp(value: unknown): string | null {
  const text = sourceValueText(value);
  if (!text) return null;
  const timestamp = new Date(text);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function readSupabaseValue(row: unknown, column: string): unknown {
  const record = asRecord(row);
  return record ? record[column] : undefined;
}

function makeIssue(
  source: "jira" | "supabase",
  index: number,
  code: NormalizationIssue["code"],
): NormalizationIssue {
  return { source, index, code };
}

function normalizeRow(
  source: "jira" | "supabase",
  row: unknown,
  index: number,
  mapping: ShiftMapping,
): { record: NormalizedShift | null; issue: NormalizationIssue | null; identifier: string } {
  if (!asRecord(row)) {
    return { record: null, issue: makeIssue(source, index, "invalid_record"), identifier: "" };
  }

  const read = source === "jira"
    ? (field: string) => readJiraValue(row, field)
    : (field: string) => readSupabaseValue(row, field);
  const identifier = sourceValueText(
    source === "jira"
      ? read(mapping.identifier.jiraField)
      : read(mapping.identifier.supabaseColumn),
  );
  if (!identifier) {
    return { record: null, issue: makeIssue(source, index, "missing_identifier"), identifier };
  }

  const values = {} as Record<ShiftField, string>;
  for (const field of SHIFT_FIELDS) {
    const value = sourceValueText(
      read(source === "jira" ? mapping.fields[field].jiraField : mapping.fields[field].supabaseColumn),
    );
    if (!value) {
      return {
        record: null,
        issue: makeIssue(source, index, `missing_${field === "processStatus" ? "process_status" : field}` as NormalizationIssue["code"]),
        identifier,
      };
    }
    values[field] = value;
  }

  const updatedAt = sourceValueText(
    read(source === "jira" ? mapping.updatedAt.jiraField : mapping.updatedAt.supabaseColumn),
  );
  if (!updatedAt) {
    return { record: null, issue: makeIssue(source, index, "missing_updated_at"), identifier };
  }
  const normalizedUpdatedAt = normalizeTimestamp(updatedAt);
  if (!normalizedUpdatedAt) {
    return { record: null, issue: makeIssue(source, index, "invalid_updated_at"), identifier };
  }

  return {
    issue: null,
    identifier,
    record: {
      identifier: comparableText(identifier),
      staffMember: comparableText(values.staffMember),
      team: comparableText(values.team),
      region: comparableText(values.region),
      environment: comparableText(values.environment),
      signal: comparableText(values.signal),
      action: comparableText(values.action),
      processStatus: comparableText(values.processStatus),
      priority: comparableText(values.priority),
      dueDate: comparableText(values.dueDate),
      updatedAt: normalizedUpdatedAt,
    },
  };
}

export function normalizeRecords(
  source: "jira" | "supabase",
  rows: unknown[],
  mapping: ShiftMapping,
): NormalizationResult {
  const records: NormalizedShift[] = [];
  const issues: NormalizationIssue[] = [];
  const identifiers = new Map<string, number>();
  let missingStableIdentifiers = 0;

  rows.forEach((row, index) => {
    const result = normalizeRow(source, row, index, mapping);
    if (result.identifier) {
      const normalizedIdentifier = comparableText(result.identifier);
      identifiers.set(normalizedIdentifier, (identifiers.get(normalizedIdentifier) ?? 0) + 1);
    }
    if (result.issue) {
      issues.push(result.issue);
      if (result.issue.code === "missing_identifier") missingStableIdentifiers += 1;
    } else if (result.record) {
      records.push(result.record);
    }
  });

  return {
    sourceCount: rows.length,
    records,
    missingStableIdentifiers,
    duplicateIdentifiers: [...identifiers.entries()]
      .filter(([, count]) => count > 1)
      .map(([identifier]) => identifier),
    issues,
  };
}

function uniqueRecordMap(records: NormalizedShift[]): Map<string, NormalizedShift> {
  const counts = new Map<string, number>();
  for (const record of records) {
    counts.set(record.identifier, (counts.get(record.identifier) ?? 0) + 1);
  }
  return new Map(
    records
      .filter((record) => counts.get(record.identifier) === 1)
      .map((record) => [record.identifier, record]),
  );
}

export function compareNormalizedShifts(
  jira: NormalizationResult,
  supabase: NormalizationResult,
): ReconciliationReport {
  const jiraMap = uniqueRecordMap(jira.records);
  const supabaseMap = uniqueRecordMap(supabase.records);
  const jiraOnly = [...jiraMap.keys()].filter((id) => !supabaseMap.has(id));
  const supabaseOnly = [...supabaseMap.keys()].filter((id) => !jiraMap.has(id));
  const fieldMismatches: FieldMismatch[] = [];
  const timestampMismatches: TimestampMismatch[] = [];

  for (const [identifier, jiraRecord] of jiraMap) {
    const supabaseRecord = supabaseMap.get(identifier);
    if (!supabaseRecord) continue;
    for (const field of SHIFT_FIELDS) {
      if (jiraRecord[field] !== supabaseRecord[field]) {
        fieldMismatches.push({
          identifier,
          field,
          jiraValue: jiraRecord[field],
          supabaseValue: supabaseRecord[field],
        });
      }
    }
    if (jiraRecord.updatedAt !== supabaseRecord.updatedAt) {
      const jiraTime = new Date(jiraRecord.updatedAt).getTime();
      const supabaseTime = new Date(supabaseRecord.updatedAt).getTime();
      timestampMismatches.push({
        identifier,
        jiraUpdatedAt: jiraRecord.updatedAt,
        supabaseUpdatedAt: supabaseRecord.updatedAt,
        staleSide: jiraTime < supabaseTime ? "jira" : "supabase",
      });
    }
  }

  const hasIssues = Boolean(
    jiraOnly.length
      || supabaseOnly.length
      || jira.duplicateIdentifiers.length
      || supabase.duplicateIdentifiers.length
      || jira.missingStableIdentifiers
      || supabase.missingStableIdentifiers
      || jira.issues.length
      || supabase.issues.length
      || fieldMismatches.length
      || timestampMismatches.length,
  );
  const isEmpty = jira.sourceCount === 0 && supabase.sourceCount === 0;

  return {
    status: hasIssues ? "MISMATCH" : isEmpty ? "EMPTY_REACHABLE" : "PASS",
    jiraCount: jira.sourceCount,
    supabaseCount: supabase.sourceCount,
    matchedCount: [...jiraMap.keys()].filter((id) => supabaseMap.has(id)).length,
    jiraOnly,
    supabaseOnly,
    duplicateIdentifiers: {
      jira: jira.duplicateIdentifiers,
      supabase: supabase.duplicateIdentifiers,
    },
    missingStableIdentifiers: {
      jira: jira.missingStableIdentifiers,
      supabase: supabase.missingStableIdentifiers,
    },
    malformedRecords: {
      jira: jira.issues.length - jira.missingStableIdentifiers,
      supabase: supabase.issues.length - supabase.missingStableIdentifiers,
    },
    fieldMismatches,
    timestampMismatches,
    staleUpdates: timestampMismatches,
  };
}

export function compareShifts(
  jiraRows: unknown[],
  supabaseRows: unknown[],
  mapping: ShiftMapping,
): ReconciliationReport {
  return compareNormalizedShifts(
    normalizeRecords("jira", jiraRows, mapping),
    normalizeRecords("supabase", supabaseRows, mapping),
  );
}