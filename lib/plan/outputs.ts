/**
 * Static output binding: can a producer action supply the value a consumer
 * action's input needs — decided from DECLARATIONS alone, without executing
 * anything (see ActionOutputDeclaration in lib/sdk/types.ts).
 *
 * Only exact, scalar outputs are bindable:
 *   output "units" → input type "units"   (exact base-unit amounts only —
 *                                          never into a human-decimal field)
 *   output "token" → input type "token"
 *   output "units[]" is descriptive, never bindable.
 */
import type { Action, ActionOutputDeclaration, ScalarInputField } from "@/lib/sdk/types";

const NATIVE = "0x0000000000000000000000000000000000000000";

export function outputDeclaration(action: Action, name: string): ActionOutputDeclaration | null {
  const outputs = action.outputs;
  if (!outputs || !Object.prototype.hasOwnProperty.call(outputs, name)) return null;
  return outputs[name];
}

export type BindCheck =
  | { ok: true; declaration: ActionOutputDeclaration }
  | { ok: false; code: "UNKNOWN_OUTPUT" | "OUTPUT_TYPE_MISMATCH"; message: string };

/** Can `producer`'s output `name` feed a consumer input of `fieldType`? */
export function canBind(producer: Action, name: string, fieldType: ScalarInputField["type"]): BindCheck {
  const decl = outputDeclaration(producer, name);
  if (!decl) {
    return { ok: false, code: "UNKNOWN_OUTPUT", message: `${producer.protocolId}/${producer.actionId} does not produce an output named "${name}".` };
  }
  const compatible = (decl.type === "units" && fieldType === "units") || (decl.type === "token" && fieldType === "token");
  if (!compatible) {
    return { ok: false, code: "OUTPUT_TYPE_MISMATCH", message: `Output "${name}" (${decl.type}) can't fill a "${fieldType}" input.` };
  }
  return { ok: true, declaration: decl };
}

/**
 * The token an amount output is denominated in, when it can be known
 * statically: the producer's `denominatedIn` input, if that input is a
 * literal (lowercased; "" means native MON). Null when it can only be known
 * after execution — then the planner checks it at bind time instead.
 */
export function staticDenomination(
  decl: ActionOutputDeclaration,
  producerLiteral: (input: string) => string | null | undefined,
): string | null {
  if (decl.type !== "units") return null;
  if (!decl.denominatedIn) return "";
  const v = producerLiteral(decl.denominatedIn.input);
  if (v === undefined) return ""; // input absent → native (the SDK convention for token inputs)
  if (v === null) return null;    // present but bound/unresolved → not known yet
  return normalizeToken(v);
}

/**
 * The ERC-20 a bindable output provably is (a "token" output) or is
 * denominated in (a "units" output), lowercased — decided statically from the
 * producer's LITERAL input named by `denominatedIn`. Null when that can't be
 * proven: native MON (input absent or the zero address), no `denominatedIn`,
 * or an input that is itself bound / unresolved. Only outputs with a proven
 * ERC-20 may be passed to a later step — native MON outputs are never bound.
 */
export function staticErc20(
  decl: ActionOutputDeclaration,
  producerLiteral: (input: string) => string | null | undefined,
): string | null {
  if (decl.type !== "units" && decl.type !== "token") return null;
  if (!decl.denominatedIn) return null;
  const v = producerLiteral(decl.denominatedIn.input);
  if (v === undefined || v === null) return null;
  const t = normalizeToken(v);
  return /^0x[0-9a-f]{40}$/.test(t) ? t : null;
}

export function normalizeToken(v: string): string {
  const t = v.trim().toLowerCase();
  return t === NATIVE ? "" : t;
}
