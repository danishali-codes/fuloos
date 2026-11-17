migrate((app) => {
  const col=app.findCollectionByNameOrId("fuloos_net_worth_snapshots");
  const field={type:"number",name:"revision",onlyInt:true,min:0};
  col.fields.add(typeof NumberField === "function" ? new NumberField(field) : field);
  app.save(col);
  app.db().newQuery("UPDATE fuloos_net_worth_snapshots SET revision=rowid").execute();
},(app) => {const col=app.findCollectionByNameOrId("fuloos_net_worth_snapshots");col.fields.removeByName("revision");app.save(col);});
