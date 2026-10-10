import type { Where } from "../core/types.ts";

export { queryableField, type SqlFragment, whereToSql, whereToSqlAt } from "./where.ts";
export {
  type CompiledQuery,
  compilePb,
  type FilterContext,
  likePattern,
  type Param,
  parsePbSort,
  PbCompiler,
  type RequestInfo,
  type RuleJoin,
  type SortField,
} from "./pbfilter.ts";
export { type ExpandTree, type FieldsTree, parseExpand, parseFields, pickFields, sortToSql } from "./helpers.ts";

/** ANDs wheres, dropping empties. */
export function andWhere(...ws: (Where | undefined)[]): Where {
  const list = ws.filter((w): w is Where => !!w && Object.keys(w).length > 0);
  return list.length === 1 ? list[0] : { and: list };
}
