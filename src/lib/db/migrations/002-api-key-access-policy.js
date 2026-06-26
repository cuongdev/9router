export default {
  version: 2,
  name: "api-key-access-policy",
  up(db) {
    const columns = db.all(`PRAGMA table_info(apiKeys)`).map((row) => row.name);
    if (!columns.includes("accessPolicy")) {
      db.exec(`ALTER TABLE apiKeys ADD COLUMN accessPolicy TEXT`);
    }
    db.run(
      `UPDATE apiKeys SET accessPolicy = ? WHERE accessPolicy IS NULL OR accessPolicy = ''`,
      [JSON.stringify({ mode: "unrestricted" })]
    );
  },
};
