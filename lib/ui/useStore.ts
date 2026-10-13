"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { Table, TableStore } from "@/lib/types";

// Reads the current table from a store. The methods are wrapped so a class
// instance does not lose `this`.
export function useTable(store: TableStore): Table {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getTable = useCallback(() => store.getTable(), [store]);
  return useSyncExternalStore(subscribe, getTable, getTable);
}
