/// <reference path="../pb_data/types.d.ts" />
const previousChecks = `
      SELECT CASE WHEN NEW.amount IS NULL OR typeof(NEW.amount) NOT IN ('integer','real') OR NEW.amount != CAST(NEW.amount AS INTEGER) OR NEW.amount < 0 OR NEW.amount > 100000000000 THEN RAISE(ABORT,'Amount must be nonnegative integer fils') END;
      SELECT CASE WHEN NOT EXISTS(
        SELECT 1 FROM fuloos_accounts a
        WHERE a.id=NEW.account_id AND (
          a.user_id=NEW.user_id
          OR (
            COALESCE(a.household_id,'')!='' AND EXISTS(
              SELECT 1 FROM fuloos_households h
              WHERE h.id=a.household_id AND (
                h.owner_id=NEW.user_id
                OR EXISTS(SELECT 1 FROM fuloos_household_members m WHERE m.household_id=h.id AND m.user_id=NEW.user_id AND m.status='active' AND m.role IN ('owner','editor'))
              )
            )
          )
        )
      ) THEN RAISE(ABORT,'Account must belong to the same user or shared household') END;
      SELECT CASE WHEN NEW.type='transfer' AND (COALESCE(NEW.to_account_id,'')='' OR COALESCE(NEW.to_account_id,'')=NEW.account_id OR COALESCE(NEW.category_id,'')!='') THEN RAISE(ABORT,'A transfer requires two different accounts and no category') END;
      SELECT CASE WHEN NEW.type!='transfer' AND COALESCE(NEW.to_account_id,'')!='' THEN RAISE(ABORT,'Only a transfer has a receiving account') END;
      SELECT CASE WHEN COALESCE(NEW.to_account_id,'')!='' AND NOT EXISTS(
        SELECT 1 FROM fuloos_accounts a
        WHERE a.id=NEW.to_account_id AND (
          a.user_id=NEW.user_id
          OR (
            COALESCE(a.household_id,'')!='' AND EXISTS(
              SELECT 1 FROM fuloos_households h
              WHERE h.id=a.household_id AND (
                h.owner_id=NEW.user_id
                OR EXISTS(SELECT 1 FROM fuloos_household_members m WHERE m.household_id=h.id AND m.user_id=NEW.user_id AND m.status='active' AND m.role IN ('owner','editor'))
              )
            )
          )
        )
      ) THEN RAISE(ABORT,'Receiving account must belong to the same user or shared household') END;
      SELECT CASE WHEN COALESCE(NEW.category_id,'')!='' AND NOT EXISTS(SELECT 1 FROM fuloos_categories c WHERE c.id=NEW.category_id AND c.user_id=NEW.user_id) THEN RAISE(ABORT,'Category must belong to the same user') END;
      SELECT CASE WHEN date(NEW.date) IS NULL OR date(NEW.date)!=NEW.date THEN RAISE(ABORT,'Transaction date must be valid') END;
      SELECT CASE WHEN COALESCE(NEW.tags,'') NOT IN ('','null') AND (json_valid(NEW.tags)=0 OR json_type(NEW.tags)!='array' OR json_array_length(NEW.tags)>20) THEN RAISE(ABORT,'Tags must be a JSON array of at most 20 items') END;
      SELECT CASE WHEN COALESCE(NEW.splits,'') NOT IN ('','null') AND (json_valid(NEW.splits)=0 OR json_type(NEW.splits)!='array') THEN RAISE(ABORT,'Splits must be a JSON array') END;
      SELECT CASE WHEN COALESCE(NEW.splits,'') NOT IN ('','null') AND json_type(NEW.splits)='array' AND json_array_length(NEW.splits)>0 AND NEW.type='transfer' THEN RAISE(ABORT,'Transfers cannot have splits') END;
      SELECT CASE WHEN COALESCE(NEW.splits,'') NOT IN ('','null') AND json_type(NEW.splits)='array' AND json_array_length(NEW.splits)>0 AND (
        EXISTS(
          SELECT 1 FROM json_each(NEW.splits) s
          WHERE json_type(s.value,'$.amount') NOT IN ('integer','real')
             OR json_extract(s.value,'$.amount')!=CAST(json_extract(s.value,'$.amount') AS INTEGER)
             OR json_extract(s.value,'$.amount')<=0
             OR (
               COALESCE(json_extract(s.value,'$.category_id'),'')!=''
               AND NOT EXISTS(
                 SELECT 1 FROM fuloos_categories c
                 WHERE c.id=json_extract(s.value,'$.category_id') AND c.user_id=NEW.user_id
               )
             )
        )
        OR (SELECT COALESCE(SUM(json_extract(s.value,'$.amount')),0) FROM json_each(NEW.splits) s)!=NEW.amount
      ) THEN RAISE(ABORT,'Splits must have positive integer amounts summing to the transaction amount') END;`;
const sharedChecks = `
      SELECT CASE WHEN NEW.amount IS NULL OR typeof(NEW.amount) NOT IN ('integer','real') OR NEW.amount != CAST(NEW.amount AS INTEGER) OR NEW.amount < 0 OR NEW.amount > 100000000000 THEN RAISE(ABORT,'Amount must be nonnegative integer fils') END;
      SELECT CASE WHEN NOT EXISTS(
        SELECT 1 FROM fuloos_accounts a
        WHERE a.id=NEW.account_id AND (
          a.user_id=NEW.user_id
          OR (
            COALESCE(a.household_id,'')!='' AND EXISTS(
              SELECT 1 FROM fuloos_households h
              WHERE h.id=a.household_id AND (
                h.owner_id=NEW.user_id
                OR EXISTS(SELECT 1 FROM fuloos_household_members m WHERE m.household_id=h.id AND m.user_id=NEW.user_id AND m.status='active' AND m.role IN ('owner','editor'))
              )
            )
          )
        )
      ) THEN RAISE(ABORT,'Account must belong to the same user or shared household') END;
      SELECT CASE WHEN NEW.type='transfer' AND (COALESCE(NEW.to_account_id,'')='' OR COALESCE(NEW.to_account_id,'')=NEW.account_id OR COALESCE(NEW.category_id,'')!='') THEN RAISE(ABORT,'A transfer requires two different accounts and no category') END;
      SELECT CASE WHEN NEW.type!='transfer' AND COALESCE(NEW.to_account_id,'')!='' THEN RAISE(ABORT,'Only a transfer has a receiving account') END;
      SELECT CASE WHEN COALESCE(NEW.to_account_id,'')!='' AND NOT EXISTS(
        SELECT 1 FROM fuloos_accounts a
        WHERE a.id=NEW.to_account_id AND (
          a.user_id=NEW.user_id
          OR (
            COALESCE(a.household_id,'')!='' AND EXISTS(
              SELECT 1 FROM fuloos_households h
              WHERE h.id=a.household_id AND (
                h.owner_id=NEW.user_id
                OR EXISTS(SELECT 1 FROM fuloos_household_members m WHERE m.household_id=h.id AND m.user_id=NEW.user_id AND m.status='active' AND m.role IN ('owner','editor'))
              )
            )
          )
        )
      ) THEN RAISE(ABORT,'Receiving account must belong to the same user or shared household') END;
      SELECT CASE WHEN COALESCE(NEW.category_id,'')!='' AND NOT EXISTS(SELECT 1 FROM fuloos_categories c WHERE c.id=NEW.category_id AND ((COALESCE((SELECT household_id FROM fuloos_accounts WHERE id=NEW.account_id),'')='' AND c.user_id=NEW.user_id) OR (COALESCE(c.household_id,'')!='' AND c.household_id=(SELECT household_id FROM fuloos_accounts WHERE id=NEW.account_id)))) THEN RAISE(ABORT,'Category must belong to the same user') END;
      SELECT CASE WHEN date(NEW.date) IS NULL OR date(NEW.date)!=NEW.date THEN RAISE(ABORT,'Transaction date must be valid') END;
      SELECT CASE WHEN COALESCE(NEW.tags,'') NOT IN ('','null') AND (json_valid(NEW.tags)=0 OR json_type(NEW.tags)!='array' OR json_array_length(NEW.tags)>20) THEN RAISE(ABORT,'Tags must be a JSON array of at most 20 items') END;
      SELECT CASE WHEN COALESCE(NEW.splits,'') NOT IN ('','null') AND (json_valid(NEW.splits)=0 OR json_type(NEW.splits)!='array') THEN RAISE(ABORT,'Splits must be a JSON array') END;
      SELECT CASE WHEN COALESCE(NEW.splits,'') NOT IN ('','null') AND json_type(NEW.splits)='array' AND json_array_length(NEW.splits)>0 AND NEW.type='transfer' THEN RAISE(ABORT,'Transfers cannot have splits') END;
      SELECT CASE WHEN COALESCE(NEW.splits,'') NOT IN ('','null') AND json_type(NEW.splits)='array' AND json_array_length(NEW.splits)>0 AND (
        EXISTS(
          SELECT 1 FROM json_each(NEW.splits) s
          WHERE json_type(s.value,'$.amount') NOT IN ('integer','real')
             OR json_extract(s.value,'$.amount')!=CAST(json_extract(s.value,'$.amount') AS INTEGER)
             OR json_extract(s.value,'$.amount')<=0
             OR (
               COALESCE(json_extract(s.value,'$.category_id'),'')!=''
               AND NOT EXISTS(
                 SELECT 1 FROM fuloos_categories c
                 WHERE c.id=json_extract(s.value,'$.category_id') AND ((COALESCE((SELECT household_id FROM fuloos_accounts WHERE id=NEW.account_id),'')='' AND c.user_id=NEW.user_id) OR (COALESCE(c.household_id,'')!='' AND c.household_id=(SELECT household_id FROM fuloos_accounts WHERE id=NEW.account_id)))
               )
             )
        )
        OR (SELECT COALESCE(SUM(json_extract(s.value,'$.amount')),0) FROM json_each(NEW.splits) s)!=NEW.amount
      ) THEN RAISE(ABORT,'Splits must have positive integer amounts summing to the transaction amount') END;`;

function installTxChecks(app, checks) {
  for (const action of ["INSERT", "UPDATE"]) {
    app
      .db()
      .newQuery(
        "DROP TRIGGER IF EXISTS fuloos_transaction_" + action.toLowerCase(),
      )
      .execute();
    app
      .db()
      .newQuery(
        "CREATE TRIGGER fuloos_transaction_" +
          action.toLowerCase() +
          " BEFORE " +
          action +
          " ON fuloos_transactions BEGIN " +
          checks +
          " END",
      )
      .execute();
  }
}
migrate(
  (app) => {
    const households = app.findCollectionByNameOrId("fuloos_households");
    const categories = app.findCollectionByNameOrId("fuloos_categories");
    const field = {
      type: "relation",
      name: "household_id",
      collectionId: households.id,
      maxSelect: 1,
      cascadeDelete: false,
    };
    categories.fields.add(
      typeof RelationField === "function" ? new RelationField(field) : field,
    );
    const read =
      "@request.auth.collectionName = 'fuloos_users' && (user_id = @request.auth.id || (household_id != '' && (household_id.owner_id = @request.auth.id || (household_id.fuloos_household_members_via_household_id.user_id ?= @request.auth.id && household_id.fuloos_household_members_via_household_id.status ?= 'active'))))";
    categories.listRule = read;
    categories.viewRule = read;
    app.save(categories);
    for (const action of ["INSERT", "UPDATE"]) {
      app
        .db()
        .newQuery(
          "CREATE TRIGGER fuloos_category_household_" +
            action.toLowerCase() +
            " BEFORE " +
            action +
            ` ON fuloos_categories BEGIN
      SELECT CASE WHEN COALESCE(NEW.household_id,'')!='' AND NOT EXISTS(
        SELECT 1 FROM fuloos_households h WHERE h.id=NEW.household_id AND (h.owner_id=NEW.user_id OR EXISTS(SELECT 1 FROM fuloos_household_members m WHERE m.household_id=h.id AND m.user_id=NEW.user_id AND m.status='active' AND m.role IN ('owner','editor')))
      ) THEN RAISE(ABORT,'Category owner must be an owner or editor of the household') END;
    END`,
        )
        .execute();
    }
    app
      .db()
      .newQuery(
        `UPDATE fuloos_categories SET household_id=COALESCE(
    (SELECT MIN(a.household_id) FROM fuloos_transactions t JOIN fuloos_accounts a ON a.id=t.account_id WHERE t.category_id=fuloos_categories.id AND a.household_id!='' AND a.user_id=fuloos_categories.user_id),
    (SELECT MIN(b.household_id) FROM fuloos_budgets b WHERE b.category_id=fuloos_categories.id AND b.household_id!='' AND b.user_id=fuloos_categories.user_id),'')`,
      )
      .execute();
    app
      .db()
      .newQuery(
        `CREATE TRIGGER fuloos_category_unshare_guard BEFORE UPDATE OF household_id ON fuloos_categories
    WHEN COALESCE(NEW.household_id,'')!=COALESCE(OLD.household_id,'') BEGIN
    SELECT CASE WHEN EXISTS(
      SELECT 1 FROM fuloos_transactions t JOIN fuloos_accounts a ON a.id=t.account_id
      WHERE COALESCE(a.household_id,'')!='' AND a.household_id!=COALESCE(NEW.household_id,'')
      AND (t.category_id=OLD.id OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(t.splits) THEN t.splits ELSE '[]' END) s WHERE json_extract(s.value,'$.category_id')=OLD.id))
    ) OR EXISTS(SELECT 1 FROM fuloos_budgets b WHERE b.category_id=OLD.id AND COALESCE(b.household_id,'')!='' AND b.household_id!=COALESCE(NEW.household_id,''))
    THEN RAISE(ABORT,'Unshare or reassign linked accounts and budgets before changing category sharing') END;
  END`,
      )
      .execute();
    installTxChecks(app, sharedChecks);
  },
  (app) => {
    app
      .db()
      .newQuery("DROP TRIGGER IF EXISTS fuloos_category_unshare_guard")
      .execute();
    installTxChecks(app, previousChecks);
    for (const a of ["insert", "update"])
      app
        .db()
        .newQuery("DROP TRIGGER IF EXISTS fuloos_category_household_" + a)
        .execute();
    const col = app.findCollectionByNameOrId("fuloos_categories");
    col.fields.removeByName("household_id");
    col.listRule =
      "@request.auth.collectionName = 'fuloos_users' && user_id = @request.auth.id";
    col.viewRule = col.listRule;
    app.save(col);
  },
);
