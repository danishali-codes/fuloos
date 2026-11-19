// Additive upgrade: extends fuloos_captured_alerts to support native mobile
// SMS review drafts (source = "sms_native") with pre-linked account routing,
// optional card_last4 metadata, and top ML category suggestions so low-confidence
// SMS transactions can be reviewed on both mobile and desktop web.
migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("fuloos_captured_alerts");
    if (!col) return;

    const sourceField = col.fields.getByName("source");
    if (sourceField && Array.isArray(sourceField.values)) {
      if (!sourceField.values.includes("sms_native")) {
        sourceField.values.push("sms_native");
      }
    }

    const addField = (Ctor, spec) => {
      if (col.fields.getByName(spec.name)) return;
      col.fields.add(typeof Ctor === "function" ? new Ctor(spec) : spec);
    };

    addField(typeof TextField === "function" ? TextField : null, {
      name: "account_id",
      type: "text",
      required: false,
      max: 64,
    });
    addField(typeof TextField === "function" ? TextField : null, {
      name: "suggested_category_id",
      type: "text",
      required: false,
      max: 64,
    });
    addField(typeof NumberField === "function" ? NumberField : null, {
      name: "confidence",
      type: "number",
      required: false,
      onlyInt: false,
      min: 0,
      max: 1,
    });
    addField(typeof JSONField === "function" ? JSONField : null, {
      name: "top_suggestions",
      type: "json",
      required: false,
      maxSize: 4096,
    });
    addField(typeof TextField === "function" ? TextField : null, {
      name: "sms_sender",
      type: "text",
      required: false,
      max: 64,
    });
    addField(typeof TextField === "function" ? TextField : null, {
      name: "card_last4",
      type: "text",
      required: false,
      max: 4,
    });

    app.save(col);

    for (const action of ["INSERT", "UPDATE"]) {
      const when = action.toLowerCase();
      app
        .db()
        .newQuery(`DROP TRIGGER IF EXISTS fuloos_captured_alerts_${when}`)
        .execute();
      app
        .db()
        .newQuery(
          `CREATE TRIGGER fuloos_captured_alerts_${when} BEFORE ${action} ON fuloos_captured_alerts BEGIN
      SELECT CASE WHEN trim(COALESCE(NEW.user_id,''))='' THEN RAISE(ABORT,'Captured alert requires a user') END;
      SELECT CASE WHEN NEW.source NOT IN ('email','shortcut','sms_native') THEN RAISE(ABORT,'Invalid alert source') END;
      SELECT CASE WHEN trim(COALESCE(NEW.raw_text,''))='' OR length(NEW.raw_text)>8000 THEN RAISE(ABORT,'Raw alert text must contain 1-8000 characters') END;
      SELECT CASE WHEN NEW.parsed_type NOT IN ('expense','income','unknown') THEN RAISE(ABORT,'Invalid parsed alert type') END;
      SELECT CASE WHEN NEW.parsed_amount IS NOT NULL AND (typeof(NEW.parsed_amount) NOT IN ('integer','real') OR NEW.parsed_amount != CAST(NEW.parsed_amount AS INTEGER) OR NEW.parsed_amount < 0 OR NEW.parsed_amount > 100000000000) THEN RAISE(ABORT,'Parsed amount must be integer fils') END;
      SELECT CASE WHEN COALESCE(NEW.parsed_date,'')!='' AND (length(NEW.parsed_date)!=10 OR strftime('%Y-%m-%d', NEW.parsed_date) IS NOT NEW.parsed_date) THEN RAISE(ABORT,'Invalid parsed date') END;
      SELECT CASE WHEN NEW.status NOT IN ('pending','imported','dismissed') THEN RAISE(ABORT,'Invalid alert status') END;
      SELECT CASE WHEN trim(COALESCE(NEW.created_at_iso,''))='' THEN RAISE(ABORT,'Alert requires created_at_iso') END;
      SELECT CASE WHEN COALESCE(NEW.account_id,'')!='' AND NOT EXISTS(SELECT 1 FROM fuloos_accounts a WHERE a.id=NEW.account_id AND a.user_id=NEW.user_id) THEN RAISE(ABORT,'Alert account belongs to another user or does not exist') END;
      SELECT CASE WHEN NEW.confidence IS NOT NULL AND NEW.confidence != '' AND (NEW.confidence < 0 OR NEW.confidence > 1) THEN RAISE(ABORT,'Alert confidence must be between 0 and 1') END;
    END`,
        )
        .execute();
    }
  },
  (app) => {
    for (const action of ["INSERT", "UPDATE"]) {
      const when = action.toLowerCase();
      app
        .db()
        .newQuery(`DROP TRIGGER IF EXISTS fuloos_captured_alerts_${when}`)
        .execute();
      app
        .db()
        .newQuery(
          `CREATE TRIGGER fuloos_captured_alerts_${when} BEFORE ${action} ON fuloos_captured_alerts BEGIN
      SELECT CASE WHEN trim(COALESCE(NEW.user_id,''))='' THEN RAISE(ABORT,'Captured alert requires a user') END;
      SELECT CASE WHEN NEW.source NOT IN ('email','shortcut') THEN RAISE(ABORT,'Invalid alert source') END;
      SELECT CASE WHEN trim(COALESCE(NEW.raw_text,''))='' OR length(NEW.raw_text)>8000 THEN RAISE(ABORT,'Raw alert text must contain 1-8000 characters') END;
      SELECT CASE WHEN NEW.parsed_type NOT IN ('expense','income','unknown') THEN RAISE(ABORT,'Invalid parsed alert type') END;
      SELECT CASE WHEN NEW.parsed_amount IS NOT NULL AND (typeof(NEW.parsed_amount) NOT IN ('integer','real') OR NEW.parsed_amount != CAST(NEW.parsed_amount AS INTEGER) OR NEW.parsed_amount < 0 OR NEW.parsed_amount > 100000000000) THEN RAISE(ABORT,'Parsed amount must be integer fils') END;
      SELECT CASE WHEN COALESCE(NEW.parsed_date,'')!='' AND (length(NEW.parsed_date)!=10 OR strftime('%Y-%m-%d', NEW.parsed_date) IS NOT NEW.parsed_date) THEN RAISE(ABORT,'Invalid parsed date') END;
      SELECT CASE WHEN NEW.status NOT IN ('pending','imported','dismissed') THEN RAISE(ABORT,'Invalid alert status') END;
      SELECT CASE WHEN trim(COALESCE(NEW.created_at_iso,''))='' THEN RAISE(ABORT,'Alert requires created_at_iso') END;
    END`,
        )
        .execute();
    }

    const col = app.findCollectionByNameOrId("fuloos_captured_alerts");
    if (!col) return;
    for (const name of [
      "account_id",
      "suggested_category_id",
      "confidence",
      "top_suggestions",
      "sms_sender",
      "card_last4",
    ]) {
      col.fields.removeByName(name);
    }
    const sourceField = col.fields.getByName("source");
    if (sourceField && Array.isArray(sourceField.values)) {
      sourceField.values = sourceField.values.filter((v) => v !== "sms_native");
    }
    app.save(col);
  },
);
