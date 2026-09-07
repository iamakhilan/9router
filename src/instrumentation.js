export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Render Free uses an ephemeral filesystem. If the SQLite DB disappears,
    // restore the complete 9Router configuration from a base64-encoded export
    // stored in NINEROUTER_BOOTSTRAP_DB. Never overwrite a non-empty DB.
    try {
      const { initDb, importDb } = await import("@/lib/db/index.js");
      await initDb();

      const bootstrap = process.env.NINEROUTER_BOOTSTRAP_DB?.trim();
      if (bootstrap) {
        const { getAdapter } = await import("@/lib/db/driver.js");
        const db = await getAdapter();
        const marker = db.get(`SELECT value FROM _meta WHERE key = ?`, ["envBootstrapAppliedAt"]);

        if (!marker) {
          const tables = [
            "settings",
            "providerConnections",
            "providerNodes",
            "proxyPools",
            "apiKeys",
            "combos",
          ];
          const hasData = tables.some((table) => {
            const row = db.get(`SELECT COUNT(*) AS c FROM ${table}`);
            return Number(row?.c || 0) > 0;
          }) || Number(db.get(`SELECT COUNT(*) AS c FROM kv`)?.c || 0) > 0;

          if (!hasData) {
            try {
              const json = Buffer.from(bootstrap, "base64").toString("utf8");
              const payload = JSON.parse(json);
              await importDb(payload);
              db.run(
                `INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                ["envBootstrapAppliedAt", new Date().toISOString()],
              );
              console.log("[DB] Applied NINEROUTER_BOOTSTRAP_DB to fresh database");
            } catch (e) {
              console.error("[DB] Bootstrap restore failed:", e?.message || e);
            }
          } else {
            console.log("[DB] Skipping bootstrap restore because the database already contains data");
          }
        }
      }

      // Keep the built-in token-saving switches enabled after every fresh
      // database restore. Headroom/PXPipe still require their own runtime
      // installation; 9Router fails open when those external services are down.
      if (process.env.NINEROUTER_AUTO_ENABLE_TOKEN_SAVERS !== "false") {
        const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
        await updateSettings({
          rtkEnabled: true,
          headroomEnabled: true,
          cavemanEnabled: true,
          ponytailEnabled: true,
        });
      }
    } catch (e) {
      console.error("[DB] Startup restore/auto-settings failed:", e?.message || e);
    }
  }
}
