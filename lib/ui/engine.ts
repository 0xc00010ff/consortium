// The engine functions the interface uses (spec section 9), gathered in one place.
export { createTableStore } from "@/lib/engine/store";
export { newTable, nextSeatId } from "@/lib/engine/table";
export { speak } from "@/lib/client/speak";
export { tableToMarkdown } from "@/lib/engine/export";
