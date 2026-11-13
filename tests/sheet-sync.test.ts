import { describe, it, expect } from "vitest";
import { parseSheetDate, rowTitle, isUntitled } from "../src/lib/sheet-sync";

describe("which sheet rows are tasks", () => {
  it("a typed title is the title", () => {
    expect(rowTitle("Update the footer hours", "abc12345-0000")).toBe("Update the footer hours");
    expect(rowTitle("  Update the footer hours ", null)).toBe("Update the footer hours");
  });
  it("a Pulp link with a blank Task cell is still a task, under a placeholder the card check fills in", () => {
    const t = rowTitle("", "abc12345-0000-1111");
    expect(t).toBe("(untitled card abc12345)");
    expect(isUntitled(t!)).toBe(true);
    expect(isUntitled("Card design for the clinic")).toBe(false);
  });
  it("blank lines and the DONE divider are not tasks", () => {
    expect(rowTitle("", null)).toBeNull();
    expect(rowTitle("DONE", null)).toBeNull();
    expect(rowTitle("Done", "abc12345-0000")).toBeNull();
  });
});

describe("sheet dates", () => {
  it("reads the formats PMs use", () => {
    expect(parseSheetDate("08-Sep-2026")?.toISOString().slice(0, 10)).toBe("2026-09-08");
    expect(parseSheetDate("8 Sept 2026")?.toISOString().slice(0, 10)).toBe("2026-09-08");
    expect(parseSheetDate("08/09/2026")?.toISOString().slice(0, 10)).toBe("2026-09-08");
    expect(parseSheetDate("2026-09-08")?.toISOString().slice(0, 10)).toBe("2026-09-08");
    expect(parseSheetDate("")).toBeNull();
    expect(parseSheetDate("tbc")).toBeNull();
  });
});

describe("the sheet's fingerprint comes from one snapshot (2026-11-13)", () => {
  it("is the same for the same rows, changes with a cell, and marks a tab that was not read", async () => {
    const { clientTabsDigest } = await import("../src/lib/sheet-sync");
    const clients = [{ id: "hc" }, { id: "lms" }, { id: "notab" }];
    const tabOf = new Map<string, string | null>([["hc", "HC MedSpa"], ["lms", "Leicester"], ["notab", null]]);
    const snap = (rows: Array<[string, string[][]]>) => ({ tabOf, rows: new Map(rows), errors: [] });
    const a = clientTabsDigest(clients, snap([["HC MedSpa", [["TASK"], ["Footer"]]], ["Leicester", [["TASK"]]]]));
    expect(clientTabsDigest(clients, snap([["Leicester", [["TASK"]]], ["HC MedSpa", [["TASK"], ["Footer"]]]]))).toBe(a);
    expect(clientTabsDigest(clients, snap([["HC MedSpa", [["TASK"], ["Footer hours"]]], ["Leicester", [["TASK"]]]]))).not.toBe(a);
    // A tab Google did not return this run must never look "unchanged" next to a run that read it.
    expect(clientTabsDigest(clients, snap([["HC MedSpa", [["TASK"], ["Footer"]]]]))).not.toBe(a);
  });
});
