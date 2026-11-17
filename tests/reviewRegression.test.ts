import test from "node:test";
import assert from "node:assert/strict";
import {
  createBackup,
  parseAndValidateBackup,
  serializeBackup,
  executeRestore,
} from "../src/backup.ts";
import { emptyLedger, type Ledger } from "../src/domain.ts";
test("v2 backup restores new features, receipts and credit-card metadata with remapped references", async () => {
  const ledger: Ledger = {
    ...emptyLedger,
    accounts: [
      {
        id: "a",
        name: "Card",
        type: "credit_card",
        opening_balance: 0,
        opening_date: "2026-01-01",
        color: "#123456",
        credit_limit: 500000,
        statement_day: 20,
        payment_due_day: 10,
        apr_bps: 2000,
        minimum_payment: 5000,
      },
    ],
    categories: [{ id: "c", name: "Food", description: "", color: "#123456" }],
    transactions: [
      {
        id: "t",
        type: "expense",
        amount: 100,
        account_id: "a",
        to_account_id: null,
        category_id: "c",
        date: "2026-01-02",
        payee: "Coffee",
        notes: "",
      },
    ],
    goals: [
      {
        id: "g",
        name: "Savings",
        kind: "savings",
        status: "active",
        target_amount: 1000,
        current_amount: 100,
        target_date: null,
        account_id: "a",
        color: "#123456",
        notes: "",
      },
    ],
    goal_contributions: [
      {
        id: "gc",
        goal_id: "g",
        transaction_id: "t",
        amount: 100,
        date: "2026-01-02",
        notes: "",
      },
    ],
    net_worth_items: [
      {
        id: "n",
        name: "Fund",
        kind: "asset",
        category: "investment",
        current_value: 10000,
        as_of_date: "2026-01-02",
        color: "#123456",
        notes: "",
      },
    ],
    net_worth_snapshots: [
      { id: "ns", item_id: "n", value: 10000, date: "2026-01-02", notes: "" },
    ],
    rules: [
      {
        id: "r",
        name: "Coffee",
        enabled: true,
        priority: 1,
        match_field: "payee",
        match_type: "contains",
        pattern: "Coffee",
        set_category_id: "c",
        add_tags: [],
        set_payee: "",
      },
    ],
  };
  const backup = createBackup(ledger);
  backup.data.attachments = [
    {
      transaction_id: "t",
      filename: "receipt.pdf",
      mime: "application/pdf",
      base64: btoa("%PDF-1.4 test"),
    },
  ];
  const parsed = parseAndValidateBackup(serializeBackup(backup)).backup;
  assert.equal(parsed.format_version, 2);
  assert.equal(parsed.data.accounts[0].credit_limit, 500000);
  let n = 0;
  const { ledger: restored } = await executeRestore({
    backup: parsed,
    mode: "empty",
    existingLedger: emptyLedger,
    existingPresets: [],
    presetStore: { save: async () => {} },
    demo: true,
    demoId: () => "new-" + ++n,
  });
  assert.equal(restored.goals?.[0].account_id, restored.accounts[0].id);
  assert.equal(
    restored.goal_contributions?.[0].goal_id,
    restored.goals?.[0].id,
  );
  assert.equal(
    restored.goal_contributions?.[0].transaction_id,
    restored.transactions[0].id,
  );
  assert.equal(
    restored.net_worth_snapshots?.[0].item_id,
    restored.net_worth_items?.[0].id,
  );
  assert.equal(restored.rules?.[0].set_category_id, restored.categories[0].id);
  assert.ok(restored.transactions[0].receipt?.startsWith("blob:"));
  URL.revokeObjectURL(restored.transactions[0].receipt!);
  const legacy = JSON.parse(serializeBackup(backup));
  legacy.format_version = 1;
  assert.equal(
    parseAndValidateBackup(JSON.stringify(legacy)).backup.format_version,
    1,
  );
  const invalid = JSON.parse(serializeBackup(backup));
  invalid.data.goal_contributions[0].goal_id = "missing";
  assert.throws(() => parseAndValidateBackup(JSON.stringify(invalid)));
});

import fs from "node:fs";
import vm from "node:vm";
import {
  setGlobalLocale,
  translateText,
  formatLocalizedAed,
} from "../src/i18n.ts";
test("Arabic text and money localization preserve the English default", () => {
  setGlobalLocale("ar");
  assert.equal(translateText("Shared categories"), "الفئات المشتركة");
  assert.equal(translateText("Save valuation"), "حفظ التقييم");
  assert.match(formatLocalizedAed(12345), /د\.إ/);
  setGlobalLocale("en");
  assert.equal(translateText("Save valuation"), "Save valuation");
});
test("server budget alerts allocate split categories just like reports", () => {
  const mod = { exports: {} as Record<string, any> };
  vm.runInNewContext(
    fs.readFileSync(
      new URL("../pocketbase/pb_hooks/notifications_lib.js", import.meta.url),
      "utf8",
    ),
    {
      module: mod,
      Intl,
      Date,
      Math,
      Number,
      String,
      Boolean,
      Array,
      Object,
      JSON,
      RegExp,
    },
  );
  const lib = mod.exports;
  const result = lib.computeBudgetAlerts(
    {
      categories: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      budgets: [
        {
          category_id: "a",
          amount: 100,
          start_month: "2026-01",
          end_month: null,
        },
        {
          category_id: "b",
          amount: 100,
          start_month: "2026-01",
          end_month: null,
        },
      ],
      transactions: [
        {
          type: "expense",
          category_id: "a",
          amount: 200,
          date: "2026-01-03",
          splits: [
            { category_id: "a", amount: 50 },
            { category_id: "b", amount: 150 },
          ],
        },
      ],
    },
    "2026-01",
  );
  assert.equal(
    result.find((r: { category: { id: string } }) => r.category.id === "a")
      .actual,
    50,
  );
  assert.equal(
    result.find((r: { category: { id: string } }) => r.category.id === "b")
      .actual,
    150,
  );
});

test("notification loading includes transactions beyond the first 2000 records", () => {
  const mod = { exports: {} as Record<string, any> };
  vm.runInNewContext(
    fs.readFileSync(
      new URL("../pocketbase/pb_hooks/notifications_lib.js", import.meta.url),
      "utf8",
    ),
    {
      module: mod,
      Intl,
      Date,
      Math,
      Number,
      String,
      Boolean,
      Array,
      Object,
      JSON,
      RegExp,
    },
  );
  const lib = mod.exports;
  const source = Array.from({ length: 2105 }, (_, i) => ({
    id: String(i),
    type: "expense",
    category_id: "a",
    amount: 100,
    date: "2026-01-01",
  }));
  const offsets: number[] = [];
  const rows = lib.readAllRecords(
    (
      _collection: string,
      _filter: string,
      _sort: string,
      limit: number,
      offset: number,
    ) => {
      offsets.push(offset);
      return source.slice(offset, offset + limit);
    },
    "fuloos_transactions",
    "user_id = {:uid}",
    { uid: "user" },
    (r: unknown) => r,
  );
  assert.equal(rows.length, 2105);
  assert.deepEqual(offsets, [0, 500, 1000, 1500, 2000]);
  const budget = lib.computeBudgetAlerts(
    {
      categories: [{ id: "a", name: "A" }],
      budgets: [
        {
          category_id: "a",
          amount: 200000,
          start_month: "2026-01",
          end_month: null,
        },
      ],
      transactions: rows,
    },
    "2026-01",
  );
  assert.equal(budget[0].actual, 210500);
});
