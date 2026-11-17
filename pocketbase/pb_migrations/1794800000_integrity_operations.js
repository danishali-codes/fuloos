/// <reference path="../pb_data/types.d.ts" />
migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("fuloos_users");
    app.save(
      new Collection({
        name: "fuloos_operations",
        type: "base",
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            name: "user_id",
            type: "relation",
            required: true,
            collectionId: users.id,
            maxSelect: 1,
            cascadeDelete: true,
          },
          { name: "key", type: "text", required: true, max: 128 },
          { name: "kind", type: "text", required: true, max: 80 },
          { name: "request_hash", type: "text", required: true, max: 64 },
          { name: "result", type: "json", required: true, maxSize: 1000000 },
        ],
        indexes: [
          "CREATE UNIQUE INDEX idx_fuloos_operations_key ON fuloos_operations (user_id,key)",
        ],
      }),
    );
    const alerts = app.findCollectionByNameOrId("fuloos_captured_alerts");
    alerts.fields.add(
      typeof RelationField === "function"
        ? new RelationField({
            name: "transaction_id",
            collectionId: app.findCollectionByNameOrId("fuloos_transactions")
              .id,
            maxSelect: 1,
            cascadeDelete: false,
          })
        : {
            type: "relation",
            name: "transaction_id",
            collectionId: app.findCollectionByNameOrId("fuloos_transactions")
              .id,
            maxSelect: 1,
            cascadeDelete: false,
          },
    );
    app.save(alerts);
  },
  (app) => {
    const alerts = app.findCollectionByNameOrId("fuloos_captured_alerts");
    alerts.fields.removeByName("transaction_id");
    app.save(alerts);
    app.delete(app.findCollectionByNameOrId("fuloos_operations"));
  },
);
