function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function owned(app, collection, id, uid) {
  const rec = app.findRecordById(collection, String(id || ""));
  if (rec.getString("user_id") !== uid)
    throw new ForbiddenError("This record belongs to another user.");
  return rec;
}
function create(app, collection, uid, values, fields) {
  const rec = new Record(app.findCollectionByNameOrId(collection));
  rec.set("user_id", uid);
  for (const field of fields)
    if (values[field] !== undefined)
      rec.set(field, values[field] === null ? "" : values[field]);
  if (collection === "fuloos_net_worth_snapshots") {
    const previous = app.findRecordsByFilter(
      collection,
      "item_id = {:id}",
      "-revision",
      1,
      0,
      { id: values.item_id },
    );
    rec.set(
      "revision",
      previous.length ? previous[0].getInt("revision") + 1 : 1,
    );
  }
  app.save(rec);
  return rec;
}
const txFields = [
  "type",
  "amount",
  "account_id",
  "to_account_id",
  "category_id",
  "date",
  "payee",
  "notes",
  "tags",
  "splits",
  "original_amount",
  "original_currency",
  "fx_rate",
];
function transaction(app, uid, values) {
  if (!values || typeof values !== "object")
    throw new BadRequestError("Invalid transaction.");
  return create(app, "fuloos_transactions", uid, values, txFields);
}
function perform(e, kind, run, fixedKey) {
  const uid = e.auth.id;
  const body = e.requestInfo().body || {};
  const key = fixedKey || String(body.operation_key || "");
  if (!key || key.length > 128)
    throw new BadRequestError("A valid operation key is required.");
  const hash = $security.sha256(
    canonical({ record_id: e.request.pathValue("id"), body }),
  );
  let result;
  $app.runInTransaction((app) => {
    const previous = app.findRecordsByFilter(
      "fuloos_operations",
      "user_id = {:uid} && key = {:key}",
      "",
      1,
      0,
      { uid, key },
    );
    if (previous.length) {
      if (
        previous[0].getString("kind") !== kind ||
        previous[0].getString("request_hash") !== hash
      )
        throw new BadRequestError(
          "This operation key has already been used for different data.",
        );
      result = previous[0].get("result");
      return;
    }
    result = run(app, uid, body);
    create(
      app,
      "fuloos_operations",
      uid,
      { key, kind, request_hash: hash, result },
      ["key", "kind", "request_hash", "result"],
    );
  });
  return e.json(200, result);
}
function contribute(e) {
  return perform(e, "goal-contribute", (app, uid, b) => {
    const goal = owned(app, "fuloos_goals", e.request.pathValue("id"), uid);
    const amount = b.amount;
    if (!Number.isSafeInteger(amount) || !amount)
      throw new BadRequestError("Enter a nonzero integer contribution.");
    const next = goal.getInt("current_amount") + amount;
    if (next < 0 || next > 100000000000)
      throw new BadRequestError(
        "Contribution exceeds the supported goal balance.",
      );
    const tx = b.record_transaction
      ? transaction(app, uid, b.record_transaction)
      : null;
    const c = create(
      app,
      "fuloos_goal_contributions",
      uid,
      {
        goal_id: goal.id,
        amount,
        date: b.date,
        notes: b.notes || "",
        transaction_id: tx ? tx.id : "",
      },
      ["goal_id", "amount", "date", "notes", "transaction_id"],
    );
    goal.set("current_amount", next);
    if (
      next >= goal.getInt("target_amount") &&
      goal.getString("status") === "active"
    )
      goal.set("status", "completed");
    if (
      next < goal.getInt("target_amount") &&
      goal.getString("status") === "completed"
    )
      goal.set("status", "active");
    app.save(goal);
    return { goal, contribution: c, transaction: tx };
  });
}
function removeContribution(e) {
  const id = e.request.pathValue("id");
  return perform(
    e,
    "goal-remove",
    (app, uid) => {
      const c = owned(app, "fuloos_goal_contributions", id, uid);
      const goal = owned(app, "fuloos_goals", c.getString("goal_id"), uid);
      const next = goal.getInt("current_amount") - c.getInt("amount");
      if (next < 0)
        throw new BadRequestError(
          "Removing this contribution would make the goal negative.",
        );
      app.delete(c);
      goal.set("current_amount", next);
      if (
        next < goal.getInt("target_amount") &&
        goal.getString("status") === "completed"
      )
        goal.set("status", "active");
      app.save(goal);
      return goal;
    },
    "goal-remove:" + id,
  );
}
function importAlert(e) {
  const id = e.request.pathValue("id");
  return perform(
    e,
    "alert-import",
    (app, uid, b) => {
      const alert = owned(app, "fuloos_captured_alerts", id, uid);
      if (alert.getString("status") !== "pending")
        throw new BadRequestError("This alert is no longer pending.");
      const tx = transaction(app, uid, b.transaction);
      alert.set("status", "imported");
      alert.set("transaction_id", tx.id);
      app.save(alert);
      return tx;
    },
    "alert-import:" + id,
  );
}
function snapshots(app, id) {
  return app.findRecordsByFilter(
    "fuloos_net_worth_snapshots",
    "item_id = {:id}",
    "-date,-revision,-id",
    0,
    0,
    { id },
  );
}
function syncItem(app, item) {
  const rows = snapshots(app, item.id);
  if (!rows.length)
    throw new BadRequestError("Keep at least one valuation for this item.");
  item.set("current_value", rows[0].getInt("value"));
  item.set("as_of_date", rows[0].getString("date"));
  app.save(item);
  return { item, snapshots: rows };
}
function saveItem(e) {
  return perform(e, "net-worth-save", (app, uid, b) => {
    const d = b.draft || {};
    let item;
    if (b.id) {
      item = owned(app, "fuloos_net_worth_items", b.id, uid);
      for (const field of [
        "name",
        "kind",
        "category",
        "color",
        "emoji",
        "notes",
      ])
        if (d[field] !== undefined) item.set(field, d[field]);
      if (
        d.current_value !== item.getInt("current_value") ||
        d.as_of_date !== item.getString("as_of_date")
      ) {
        create(
          app,
          "fuloos_net_worth_snapshots",
          uid,
          {
            item_id: item.id,
            value: d.current_value,
            date: d.as_of_date,
            notes: "Edited valuation",
          },
          ["item_id", "value", "date", "notes"],
        );
      }
      app.save(item);
    } else {
      item = create(app, "fuloos_net_worth_items", uid, d, [
        "name",
        "kind",
        "category",
        "color",
        "emoji",
        "notes",
        "current_value",
        "as_of_date",
      ]);
      create(
        app,
        "fuloos_net_worth_snapshots",
        uid,
        {
          item_id: item.id,
          value: d.current_value,
          date: d.as_of_date,
          notes: "Initial valuation",
        },
        ["item_id", "value", "date", "notes"],
      );
    }
    return syncItem(app, item);
  });
}
function valueItem(e) {
  return perform(e, "net-worth-value", (app, uid, b) => {
    const item = owned(app, "fuloos_net_worth_items", b.item_id, uid);
    create(
      app,
      "fuloos_net_worth_snapshots",
      uid,
      { item_id: item.id, value: b.value, date: b.date, notes: b.notes || "" },
      ["item_id", "value", "date", "notes"],
    );
    return syncItem(app, item);
  });
}
function removeSnapshot(e) {
  const id = e.request.pathValue("id");
  return perform(
    e,
    "net-worth-remove",
    (app, uid) => {
      const snap = owned(app, "fuloos_net_worth_snapshots", id, uid);
      const item = owned(
        app,
        "fuloos_net_worth_items",
        snap.getString("item_id"),
        uid,
      );
      if (snapshots(app, item.id).length <= 1)
        throw new BadRequestError("Keep at least one valuation for this item.");
      app.delete(snap);
      return syncItem(app, item);
    },
    "net-worth-remove:" + id,
  );
}
module.exports = {
  contribute,
  removeContribution,
  importAlert,
  saveItem,
  valueItem,
  removeSnapshot,
};

function share(e, table) {
  const uid = e.auth.id,
    b = e.requestInfo().body || {};
  let result;
  $app.runInTransaction((app) => {
    const record = owned(app, table, b.id, uid);
    const hid = String(b.household_id || "");
    if (hid) {
      const h = app.findRecordById("fuloos_households", hid);
      const editors = app.findRecordsByFilter(
        "fuloos_household_members",
        "household_id = {:hid} && user_id = {:uid} && status = 'active' && (role = 'owner' || role = 'editor')",
        "",
        1,
        0,
        { hid, uid },
      );
      if (h.getString("owner_id") !== uid && !editors.length)
        throw new ForbiddenError(
          "Join this household as an editor before sharing.",
        );
      const ids = {};
      if (table === "fuloos_budgets")
        ids[record.getString("category_id")] = true;
      else {
        for (let offset = 0; ; offset += 500) {
          const txs = app.findRecordsByFilter(
            "fuloos_transactions",
            "account_id = {:id}",
            "id",
            500,
            offset,
            { id: record.id },
          );
          for (const tx of txs) {
            if (tx.getString("category_id"))
              ids[tx.getString("category_id")] = true;
            const splits = tx.get("splits") || [];
            for (const split of splits)
              if (split.category_id) ids[split.category_id] = true;
          }
          if (txs.length < 500) break;
        }
      }
      for (const id of Object.keys(ids)) {
        if (!id) continue;
        const category = app.findRecordById("fuloos_categories", id);
        if (category.getString("household_id") === hid) continue;
        if (
          category.getString("user_id") !== uid ||
          category.getString("household_id")
        )
          throw new BadRequestError(
            "A referenced category is private or shared with another household. Reassign it before sharing.",
          );
        category.set("household_id", hid);
        app.save(category);
      }
    }
    record.set("household_id", hid);
    app.save(record);
    result = record;
  });
  return e.json(200, result);
}
module.exports.shareAccount = (e) => share(e, "fuloos_accounts");
module.exports.shareBudget = (e) => share(e, "fuloos_budgets");
