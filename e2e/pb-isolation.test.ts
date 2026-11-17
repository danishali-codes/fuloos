import assert from "node:assert/strict";
import test from "node:test";
import { BackendError, PocketBaseBackend } from "../src/backend.ts";
import { checkSchemaStatus } from "../src/schemaStatus.ts";

const pbUrl = process.env.FULOOS_PB_URL;
if (!pbUrl) {
  throw new Error("FULOOS_PB_URL must be set when running pb-isolation.test.ts");
}

function makeBackend(): PocketBaseBackend {
  return new PocketBaseBackend(pbUrl!);
}

function isRejectedIsolation(err: unknown): boolean {
  return (
    err instanceof BackendError &&
    (err.status === 404 || err.status === 400 || err.status === 403)
  );
}

test("PocketBase migrations apply cleanly and enforce strict two-user isolation", async () => {
  const backendA = makeBackend();
  const backendB = makeBackend();

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const emailA = `user-a-${suffix}@example.com`;
  const emailB = `user-b-${suffix}@example.com`;
  const password = "TestPassword123!";

  const signUpA = await backendA.signUp(emailA, password);
  const signUpB = await backendB.signUp(emailB, password);
  assert.ok(signUpA.session?.user.id);
  assert.ok(signUpB.session?.user.id);

  // 1. All expected fuloos_* collections exist after migrations run from empty.
  const schema = await checkSchemaStatus((table) => backendA.probeCollection(table));
  assert.equal(schema.checked, true);
  assert.equal(schema.ok, true);
  assert.deepEqual(schema.missing, []);

  // 2. User A populates every user-owned collection.
  const accountA = await backendA.save("accounts", {
    name: "User A Checking",
    type: "current",
    opening_balance: 100000,
    opening_date: "2026-01-01",
    color: "#1d5b48",
    emoji: "🏦",
  });
  const cardA = await backendA.save("accounts", {
    name: "User A Card",
    type: "credit_card",
    opening_balance: -50000,
    opening_date: "2026-01-01",
    color: "#696198",
    emoji: "💳",
    credit_limit: 2500000,
    statement_day: 20,
    payment_due_day: 10,
    apr_bps: 2499,
    minimum_payment: 50000,
  });
  assert.equal(cardA.credit_limit, 2500000);
  assert.equal(cardA.statement_day, 20);
  assert.equal(cardA.payment_due_day, 10);
  assert.equal(cardA.apr_bps, 2499);
  assert.equal(cardA.minimum_payment, 50000);
  const categoryA = await backendA.save("categories", {
    name: "User A Groceries",
    description: "Food",
    color: "#1d5b48",
    emoji: "🛒",
  });
  const txA = await backendA.save("transactions", {
    type: "expense",
    amount: 2500,
    account_id: accountA.id,
    to_account_id: "",
    category_id: categoryA.id,
    date: "2026-01-15",
    payee: "Carrefour",
    notes: "User A private note",
    tags: ["groceries", "weekly"],
    splits: [{ category_id: categoryA.id, amount: 2500, notes: "Food" }],
  });
  const ruleA = await backendA.save("rules", {
    name: "Carrefour auto-tag",
    enabled: true,
    priority: 10,
    match_field: "payee",
    match_type: "contains",
    pattern: "carrefour",
    set_category_id: categoryA.id,
    add_tags: ["groceries"],
    set_payee: "",
  });
  const recurringA = await backendA.save("recurring", {
    name: "User A Internet",
    type: "expense",
    amount: 35000,
    amount_type: "fixed",
    account_id: accountA.id,
    category_id: categoryA.id,
    frequency: "monthly",
    start_date: "2026-01-01",
    end_date: "",
    notes: "",
    status: "active",
  });
  const occurrenceA = await backendA.save("recurring_occurrences", {
    recurring_id: recurringA.id,
    occurrence_date: "2026-01-01",
    transaction_id: txA.id,
    match_source: "manual",
    match_reason: "test",
  });
  const prefsA = await backendA.save("recurring_prefs", {
    auto_detect: "on",
    auto_match: "auto",
    dismissed_keys: ["k1"],
  });
  const budgetA = await backendA.save("budgets", {
    category_id: categoryA.id,
    amount: 150000,
    start_month: "2026-01",
    end_month: "",
  });
  const goalA = await backendA.save("goals", {
    name: "User A Emergency",
    target_amount: 500000,
    current_amount: 100000,
    target_date: "2026-12-31",
    account_id: accountA.id,
    color: "#1d5b48",
    emoji: "🛟",
    kind: "savings",
    status: "active",
    notes: "User A goal",
  });
  const contributionA = await backendA.save("goal_contributions", {
    goal_id: goalA.id,
    amount: 100000,
    date: "2026-01-15",
    transaction_id: txA.id,
    notes: "Initial deposit",
  });
  const captureTokenA = await backendA.save("capture_tokens", {
    token_hash: "a".repeat(64),
    token_preview: "flc_aaaa…aaaa",
    enabled: true,
    default_account_id: accountA.id,
  });
  const capturedAlertA = await backendA.createCapturedAlert({
    source: "email",
    subject: "Liv Alert",
    raw_text: "Purchase of AED 25.00 with Debit Card ending 1234 at CARREFOUR.",
    parsed_type: "expense",
    parsed_amount: 2500,
    parsed_date: "2026-01-15",
    parsed_payee: "Carrefour",
    parsed_notes: "Captured Liv alert",
    account_hint: "Liv · Card 1234",
    status: "pending",
    created_at_iso: "2026-01-15T10:00:00.000Z",
  });
  const nwItemA = await backendA.save("net_worth_items", {
    name: "User A Gold",
    kind: "asset",
    category: "gold",
    current_value: 250000,
    as_of_date: "2026-01-15",
    color: "#b08448",
    emoji: "🪙",
    notes: "User A gold",
  });
  const nwSnapshotA = await backendA.save("net_worth_snapshots", {
    item_id: nwItemA.id,
    value: 250000,
    date: "2026-01-15",
    notes: "Initial valuation",
  });
  const pushSubA = await backendA.savePushSubscription({
    endpoint: `https://push.example.com/sub/${suffix}`,
    p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    auth: "tBHItJI5svbpez7KI4CCXg",
    user_agent: "FuloosTest/1.0",
    created_at_iso: "2026-01-15T10:00:00.000Z",
  });

  // 3. User B loads their ledger and sees zero records from User A.
  const ledgerB = await backendB.load();
  assert.equal(ledgerB.accounts.length, 0);
  assert.equal(ledgerB.categories.length, 0);
  assert.equal(ledgerB.transactions.length, 0);
  assert.equal(ledgerB.recurring?.length ?? 0, 0);
  assert.equal(ledgerB.recurring_occurrences?.length ?? 0, 0);
  assert.equal(ledgerB.budgets?.length ?? 0, 0);
  assert.equal(ledgerB.goals?.length ?? 0, 0);
  assert.equal(ledgerB.goal_contributions?.length ?? 0, 0);
  assert.equal(ledgerB.net_worth_items?.length ?? 0, 0);
  assert.equal(ledgerB.net_worth_snapshots?.length ?? 0, 0);
  assert.equal(ledgerB.rules?.length ?? 0, 0);
  assert.deepEqual(ledgerB.recurring_prefs?.dismissed_keys, []);
  const alertsB = await backendB.loadCapturedAlerts();
  assert.equal(alertsB.supported, true);
  assert.equal(alertsB.alerts.length, 0);
  const tokenB = await backendB.loadCaptureToken();
  assert.equal(tokenB.supported, true);
  assert.equal(tokenB.token, null);
  const pushSubsB = await backendB.loadPushSubscriptions();
  assert.equal(pushSubsB.supported, true);
  assert.equal(pushSubsB.subscriptions.length, 0);

  // 4. User B cannot mutate or delete any of User A's records by ID.
  const userARecords: Array<{
    table: Parameters<PocketBaseBackend["remove"]>[0];
    id: string;
  }> = [
    { table: "accounts", id: accountA.id },
    { table: "categories", id: categoryA.id },
    { table: "transactions", id: txA.id },
    { table: "rules", id: ruleA.id },
    { table: "recurring", id: recurringA.id },
    { table: "recurring_occurrences", id: occurrenceA.id },
    { table: "recurring_prefs", id: prefsA.id },
    { table: "budgets", id: budgetA.id },
    { table: "goals", id: goalA.id },
    { table: "goal_contributions", id: contributionA.id },
    { table: "net_worth_items", id: nwItemA.id },
    { table: "net_worth_snapshots", id: nwSnapshotA.id },
    { table: "capture_tokens", id: captureTokenA.id },
    { table: "captured_alerts", id: capturedAlertA.id },
    { table: "push_subscriptions", id: pushSubA.id },
  ];
  for (const { table, id } of userARecords) {
    await assert.rejects(
      () => backendB.remove(table, id),
      isRejectedIsolation,
      `User B should not be able to delete User A's ${table}`,
    );
  }

  // 5. User B creates their own account & category, then tries to reference User A's IDs.
  const accountB = await backendB.save("accounts", {
    name: "User B Checking",
    type: "current",
    opening_balance: 50000,
    opening_date: "2026-01-01",
    color: "#696198",
    emoji: "💳",
  });
  const categoryB = await backendB.save("categories", {
    name: "User B Dining",
    description: "",
    color: "#696198",
    emoji: "🍽️",
  });

  // Cross-user foreign key references must be rejected.
  await assert.rejects(
    () =>
      backendB.save("transactions", {
        type: "expense",
        amount: 1000,
        account_id: accountA.id,
        to_account_id: "",
        category_id: categoryB.id,
        date: "2026-01-16",
        payee: "Hijack",
        notes: "",
      }),
    isRejectedIsolation,
  );
  await assert.rejects(
    () =>
      backendB.save("transactions", {
        type: "expense",
        amount: 1000,
        account_id: accountB.id,
        to_account_id: "",
        category_id: categoryA.id,
        date: "2026-01-16",
        payee: "Hijack",
        notes: "",
      }),
    isRejectedIsolation,
  );
  await assert.rejects(
    () =>
      backendB.save("budgets", {
        category_id: categoryA.id,
        amount: 10000,
        start_month: "2026-01",
        end_month: "",
      }),
    isRejectedIsolation,
  );
  await assert.rejects(
    () =>
      backendB.save("recurring", {
        name: "Hijack",
        type: "expense",
        amount: 1000,
        amount_type: "fixed",
        account_id: accountA.id,
        category_id: categoryB.id,
        frequency: "monthly",
        start_date: "2026-01-01",
        end_date: "",
        notes: "",
        status: "active",
      }),
    isRejectedIsolation,
  );
  await assert.rejects(
    () =>
      backendB.save("recurring_occurrences", {
        recurring_id: recurringA.id,
        occurrence_date: "2026-02-01",
        transaction_id: txA.id,
        match_source: "manual",
        match_reason: "",
      }),
    isRejectedIsolation,
  );
  await assert.rejects(
    () =>
      backendB.save("goals", {
        name: "Hijack Account",
        target_amount: 100000,
        current_amount: 0,
        target_date: "",
        account_id: accountA.id,
        color: "#696198",
        kind: "savings",
        status: "active",
        notes: "",
      }),
    isRejectedIsolation,
  );
  await assert.rejects(
    () =>
      backendB.save("goal_contributions", {
        goal_id: goalA.id,
        amount: 5000,
        date: "2026-01-16",
        transaction_id: "",
        notes: "Hijack goal",
      }),
    isRejectedIsolation,
  );
  const goalB = await backendB.save("goals", {
    name: "User B Goal",
    target_amount: 100000,
    current_amount: 0,
    target_date: "",
    account_id: accountB.id,
    color: "#696198",
    kind: "sinking_fund",
    status: "active",
    notes: "",
  });
  await assert.rejects(
    () =>
      backendB.save("goal_contributions", {
        goal_id: goalB.id,
        amount: 5000,
        date: "2026-01-16",
        transaction_id: txA.id,
        notes: "Hijack tx",
      }),
    isRejectedIsolation,
  );

  await assert.rejects(
    () =>
      backendB.save("rules", {
        name: "Hijack rule",
        enabled: true,
        priority: 1,
        match_field: "payee",
        match_type: "contains",
        pattern: "x",
        set_category_id: categoryA.id,
      }),
    isRejectedIsolation,
  );
  await assert.rejects(
    () =>
      backendB.save("transactions", {
        type: "expense",
        amount: 2000,
        account_id: accountB.id,
        to_account_id: "",
        category_id: categoryB.id,
        date: "2026-01-16",
        payee: "Bad split",
        notes: "",
        splits: [{ category_id: categoryB.id, amount: 1500 }],
      }),
    isRejectedIsolation,
  );

  await assert.rejects(
    () =>
      backendB.save("capture_tokens", {
        token_hash: "b".repeat(64),
        token_preview: "flc_bbbb…bbbb",
        enabled: true,
        default_account_id: accountA.id,
      }),
    isRejectedIsolation,
  );

  await assert.rejects(
    () =>
      backendB.save("net_worth_snapshots", {
        item_id: nwItemA.id,
        value: 10000,
        date: "2026-01-16",
        notes: "Hijack net worth item",
      }),
    isRejectedIsolation,
  );
  await assert.rejects(
    () =>
      backendB.save("net_worth_items", {
        name: "Mismatched kind",
        kind: "asset",
        category: "mortgage",
        current_value: 10000,
        as_of_date: "2026-01-16",
        color: "#1d5b48",
        notes: "",
      }),
    isRejectedIsolation,
  );

  // 6. User A's load still only contains User A's own records.
  const ledgerA = await backendA.load();
  assert.equal(ledgerA.accounts.length, 2);
  assert.ok(ledgerA.accounts.some((a) => a.id === accountA.id));
  const loadedCardA = ledgerA.accounts.find((a) => a.id === cardA.id);
  assert.ok(loadedCardA);
  assert.equal(loadedCardA.credit_limit, 2500000);
  assert.equal(loadedCardA.statement_day, 20);
  assert.equal(loadedCardA.payment_due_day, 10);
  assert.equal(loadedCardA.apr_bps, 2499);
  assert.equal(loadedCardA.minimum_payment, 50000);
  assert.equal(ledgerA.categories.length, 1);
  assert.equal(ledgerA.transactions.length, 1);
  assert.deepEqual(ledgerA.transactions[0].tags, ["groceries", "weekly"]);
  assert.equal(ledgerA.transactions[0].splits?.length, 1);
  assert.equal(ledgerA.rules?.length, 1);
  assert.equal(ledgerA.recurring?.length, 1);
  assert.equal(ledgerA.recurring_occurrences?.length, 1);
  assert.equal(ledgerA.budgets?.length, 1);
  assert.equal(ledgerA.goals?.length, 1);
  assert.equal(ledgerA.goal_contributions?.length, 1);
  assert.equal(ledgerA.net_worth_items?.length, 1);
  assert.equal(ledgerA.net_worth_snapshots?.length, 1);
  const alertsA = await backendA.loadCapturedAlerts();
  assert.equal(alertsA.supported, true);
  assert.equal(alertsA.alerts.length, 1);
  assert.equal(alertsA.alerts[0].id, capturedAlertA.id);
  const pushSubsA = await backendA.loadPushSubscriptions();
  assert.equal(pushSubsA.supported, true);
  assert.equal(pushSubsA.subscriptions.length, 1);
  assert.equal(pushSubsA.subscriptions[0].id, pushSubA.id);
  // Saving the same endpoint updates in-place instead of creating a duplicate.
  const updatedSubA = await backendA.savePushSubscription({
    endpoint: pushSubA.endpoint,
    p256dh: pushSubA.p256dh,
    auth: pushSubA.auth,
    user_agent: "FuloosTest/2.0",
    created_at_iso: "2026-01-15T10:05:00.000Z",
  });
  assert.equal(updatedSubA.id, pushSubA.id);
  assert.equal(updatedSubA.user_agent, "FuloosTest/2.0");

  // 7. Multi-currency round-trip and SQLite trigger enforcement.
  const usdAccount = await backendB.save("accounts", {
    name: "User B USD",
    type: "current",
    currency: "USD",
    opening_balance: 0,
    opening_date: "2026-01-01",
    color: "#696198",
  });
  assert.equal(usdAccount.currency, "USD");
  const fxTx = await backendB.save("transactions", {
    type: "expense",
    amount: 36725,
    account_id: usdAccount.id,
    to_account_id: "",
    category_id: categoryB.id,
    date: "2026-01-20",
    payee: "AWS",
    notes: "",
    original_currency: "USD",
    original_amount: 10000,
    fx_rate: 3.6725,
  });
  assert.equal(fxTx.original_currency, "USD");
  assert.equal(fxTx.original_amount, 10000);
  assert.equal(fxTx.fx_rate, 3.6725);
  await assert.rejects(
    () =>
      backendB.save("transactions", {
        type: "expense",
        amount: 36725,
        account_id: usdAccount.id,
        to_account_id: "",
        category_id: categoryB.id,
        date: "2026-01-20",
        payee: "Bad FX",
        notes: "",
        original_currency: "USD",
        original_amount: 10000,
        fx_rate: 0,
      }),
    isRejectedIsolation,
  );

  // 8. Shared / Household Mode: selective sharing & non-member isolation.
  const backendC = makeBackend();
  const signUpC = await backendC.signUp(`user-c-${suffix}@example.com`, password);
  assert.ok(signUpC.session?.user.id);

  const { household: householdA } = await backendA.createHousehold("User A Home");
  const invite = await backendA.createHouseholdInvite(householdA.id, "editor");
  assert.ok(invite.invite_code);

  // Share accountA with the household, but keep cardA private (household_id = null).
  const sharedAccA = await backendA.shareAccountWithHousehold(
    accountA.id,
    householdA.id,
  );
  assert.equal(sharedAccA.household_id, householdA.id);

  // (a) Non-member User C CANNOT read/edit User A's household, invites, or shared account.
  const householdsC = await backendC.loadHouseholds();
  assert.equal(householdsC.supported, true);
  assert.equal(householdsC.households.length, 0);
  assert.equal(householdsC.members.length, 0);
  const ledgerC = await backendC.load();
  assert.equal(ledgerC.accounts.length, 0);
  assert.equal(ledgerC.transactions.length, 0);
  await assert.rejects(
    () => backendC.save("accounts", { name: "Hijack Shared" }, accountA.id),
    isRejectedIsolation,
  );

  // (b) User B joins via invite_code and CAN read the shared account & its transactions.
  const joined = await backendB.joinHouseholdByCode(invite.invite_code!);
  assert.equal(joined.household.id, householdA.id);
  assert.equal(joined.member.status, "active");

  const ledgerBAfterJoin = await backendB.load();
  const accountIdsB = new Set(ledgerBAfterJoin.accounts.map((a) => a.id));
  const txIdsB = new Set(ledgerBAfterJoin.transactions.map((t) => t.id));
  assert.equal(accountIdsB.has(accountA.id), true);
  assert.equal(txIdsB.has(txA.id), true);

  // (c) User B STILL CANNOT read User A's private (non-shared) account (cardA).
  assert.equal(accountIdsB.has(cardA.id), false);

  // Editor User B can also record a transaction on the shared account.
  const sharedTxByB = await backendB.save("transactions", {
    type: "expense",
    amount: 1500,
    account_id: accountA.id,
    to_account_id: "",
    category_id: categoryA.id,
    date: "2026-01-21",
    payee: "Shared Coffee",
    notes: "",
  });
  assert.equal(sharedTxByB.account_id, accountA.id);

  assert.ok((await backendB.load()).categories.some(c => c.id === categoryA.id));
  await backendB.updateTransactions([{...txA,payee:"Edited by household editor"}],()=>{});
  const viewerInvite=await backendA.createHouseholdInvite(householdA.id,"viewer");
  const viewer=await backendC.joinHouseholdByCode(viewerInvite.invite_code!);
  assert.ok((await backendC.load()).accounts.some(a => a.id === accountA.id));
  await assert.rejects(() => backendC.save("accounts",{name:"Viewer edit"},accountA.id), isRejectedIsolation);
  await assert.rejects(() => backendC.save("transactions",{payee:"Viewer edit"},txA.id), isRejectedIsolation);
  await assert.rejects(() => backendC.remove("transactions",txA.id), isRejectedIsolation);
  await assert.rejects(() => backendC.save("transactions",{type:"expense",amount:1,account_id:accountA.id,to_account_id:"",category_id:categoryA.id,date:"2026-01-22",payee:"Viewer create",notes:""}), isRejectedIsolation);
  await backendA.removeHouseholdMember(viewer.member.id);
  assert.equal((await backendC.load()).accounts.some(a => a.id === accountA.id),false);
  await assert.rejects(() => backendC.joinHouseholdByCode(viewerInvite.invite_code!));

});

test("atomic operations roll back, are idempotent, preserve isolation and use fresh totals", async () => {
  const a = makeBackend(), b = makeBackend();
  const suffix = crypto.randomUUID();
  await a.signUp("atomic-a-" + suffix + "@example.com", "TestPassword123!");
  await b.signUp("atomic-b-" + suffix + "@example.com", "TestPassword123!");
  const acc = await a.save("accounts", {name:"Cash",type:"cash",opening_balance:0,opening_date:"2026-01-01",color:"#123456"});
  const goal = await a.save("goals", {name:"Savings",kind:"savings",status:"active",target_amount:100000,current_amount:0,color:"#123456",notes:""});
  const tx = {type:"expense",amount:100,account_id:acc.id,to_account_id:"",category_id:"",date:"2026-01-02",payee:"Goal",notes:""};
  const body = {amount:100,date:"2026-01-02",notes:"first",record_transaction:tx,operation_key:crypto.randomUUID()};
  const first = await a.contributeGoal(goal.id, body);
  const retry = await a.contributeGoal(goal.id, body);
  assert.equal(first.contribution.id, retry.contribution.id);
  assert.equal((await a.load()).transactions.length, 1);
  await assert.rejects(() => b.contributeGoal(goal.id, {...body, operation_key:crypto.randomUUID()}), isRejectedIsolation);
  await Promise.all([100,200].map(amount => a.contributeGoal(goal.id, {amount,date:"2026-01-03",notes:"parallel",operation_key:crypto.randomUUID()})));
  assert.equal((await a.load()).goals?.[0].current_amount, 400);
  await assert.rejects(() => a.contributeGoal(goal.id, {...body, date:"bad",operation_key:crypto.randomUUID()}));
  assert.equal((await a.load()).transactions.length, 1, "failed contribution rolls back its transaction");
  const reduced = await a.removeGoalContribution(first.contribution.id);
  assert.equal(reduced.current_amount,300);
  await a.removeGoalContribution(first.contribution.id);
  assert.equal((await a.load()).goals?.[0].current_amount,300);
  const alert = await a.createCapturedAlert({source:"shortcut",subject:"",raw_text:"Bank purchase AED 1",parsed_type:"expense",parsed_amount:100,parsed_date:"2026-01-02",parsed_payee:"Coffee",parsed_notes:"",account_hint:"",status:"pending",created_at_iso:new Date().toISOString()});
  const imported = await a.importCapturedAlert(alert.id,tx);
  const importedRetry = await a.importCapturedAlert(alert.id,tx);
  assert.equal(importedRetry.id,imported.id);
  assert.equal((await a.load()).transactions.length,2);
  await assert.rejects(() => b.importCapturedAlert(alert.id,tx), isRejectedIsolation);
  const item = await a.saveNetWorthItemAtomic({name:"Investment",kind:"asset",category:"investment",current_value:1000,as_of_date:"2026-01-01",color:"#123456",notes:""},undefined,crypto.randomUUID());
  const valuationKey=crypto.randomUUID();
  const valued = await a.saveNetWorthValuationAtomic(item.item.id,2000,"2026-02-01","",valuationKey);
  const valuedRetry = await a.saveNetWorthValuationAtomic(item.item.id,2000,"2026-02-01","",valuationKey);
  assert.equal(valuedRetry.snapshots.length,2);
  const newest=valued.snapshots.find(s => s.date === "2026-02-01")!;
  const reverted=await a.deleteNetWorthSnapshotAtomic(newest.id);
  assert.equal(reverted.item.current_value,1000);
  assert.equal(reverted.item.as_of_date,"2026-01-01");
  await assert.rejects(() => a.deleteNetWorthSnapshotAtomic(reverted.snapshots[0].id));
  await assert.rejects(() => b.saveNetWorthValuationAtomic(item.item.id,5000,"2026-03-01","",crypto.randomUUID()), isRejectedIsolation);
});
