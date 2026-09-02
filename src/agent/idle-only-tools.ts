/**
 * Herramientas de "solo estado" — no cuentan como acción real para efectos
 * de la detección de inactividad (idle-turn) en el loop principal.
 */
const IDLE_ONLY_TOOL_NAMES = [
  "system_synopsis",
  "review_memory",
  "list_children",
  "list_skills",
  "git_status",
  "git_log",
  "recall_facts",
  "recall_procedure",
  "heartbeat_ping",
] as const;

export const IDLE_ONLY_TOOLS = new Set<string>(IDLE_ONLY_TOOL_NAMES);

export function isIdleOnlyTool(name: string): boolean {
  return IDLE_ONLY_TOOLS.has(name);
}
