import { translateText as uiText } from "./i18n";
import { money, plural, type Account, type Ledger } from "./domain";
import type {
  CsvOptions,
  ImportTransaction,
  previewCsv,
} from "./csv";
import type { TransferDecision, TransferMatch } from "./transferMatch";

type CsvPreviewRow = ReturnType<typeof previewCsv>[number];

function transferSummary(applied: TransferMatch[]): string {
  const count = (kind: TransferMatch["kind"]) =>
    applied.filter((m) => m.kind === kind).length;
  const parts = [
    count("named") &&
      `${plural(count("named"), "row is imported as a new transfer", "rows are imported as new transfers")}`,
    count("pair") &&
      `${plural(count("pair"), "row completes a transfer", "rows complete transfers")} with an entry already in another account (that entry becomes the transfer, no new row)`,
    count("recorded") &&
      `${plural(count("recorded"), "row is already recorded as a transfer and skipped", "rows are already recorded as transfers and skipped")} as duplicates`,
  ].filter(Boolean);
  return parts.length
    ? `${parts.join("; ")}.`
    : "No rows are treated as transfers yet.";
}

export function CsvReviewSection({
  ledger,
  data,
  options,
  skip,
  header,
  busy,
  done,
  parseError,
  preview,
  visible,
  selected,
  filter,
  includeDuplicates,
  excluded,
  matches,
  matchRows,
  pendingMatches,
  applied,
  appliedByIndex,
  matchByIndex,
  transfers,
  accountById,
  matchLabel,
  onDecide,
  onSetFilter,
  onSetIncludeDuplicates,
  onToggleExcluded,
  onChangeTransfers,
}: {
  ledger: Ledger;
  data: string[][];
  options: CsvOptions;
  skip: number;
  header: boolean;
  busy: boolean;
  done: boolean;
  parseError: string;
  preview: CsvPreviewRow[];
  visible: CsvPreviewRow[];
  selected: CsvPreviewRow[];
  filter: string;
  includeDuplicates: boolean;
  excluded: Set<number>;
  matches: TransferMatch[];
  matchRows: Map<number, ImportTransaction>;
  pendingMatches: TransferMatch[];
  applied: TransferMatch[];
  appliedByIndex: Map<number, TransferMatch>;
  matchByIndex: Map<number, TransferMatch>;
  transfers: Record<number, string>;
  accountById: Map<string, Account>;
  matchLabel: (m: TransferMatch) => string;
  onDecide: (indexes: number[], decision: TransferDecision) => void;
  onSetFilter: (filter: string) => void;
  onSetIncludeDuplicates: (checked: boolean) => void;
  onToggleExcluded: (index: number, checked: boolean) => void;
  onChangeTransfers: (next: Record<number, string>) => void;
}) {
  const invalidCount = preview.filter((r) => r.error).length;
  const duplicateCount = preview.filter((r) => r.duplicate).length;

  return (
    <>
      {matches.length > 0 && !parseError && !done && (
        <section className="transfer-matches" aria-labelledby="tm-title">
          <h3 id="tm-title">{uiText("Transfers between your accounts")}</h3>
          <p className="muted">
            {transferSummary(applied)} {uiText("Change any row with its type menu in the table.")} </p>
          {pendingMatches.length > 0 && (
            <>
              <p>
                {pendingMatches.length === 1
                  ? uiText("One more row looks like a transfer.")
                  : `${pendingMatches.length} more rows look like transfers.`}{" "} {uiText("Confirm the ones that are:")} </p>
              <ul className="transfer-match-list">
                {pendingMatches.map((m) => {
                  const t = matchRows.get(m.index);
                  return (
                    <li key={m.index}>
                      <div>
                        <b>
                          {t?.date} ·{" "}
                          {t
                            ? money(t.amount * (t.type === "expense" ? -1 : 1))
                            : ""}{" "}
                          · {t?.payee || "No payee"}
                        </b>
                        <span className="muted small">
                          {matchLabel(m)} ({m.reasons.join(", ")})
                        </span>
                      </div>
                      <div className="csv-category-actions">
                        <button
                          type="button"
                          className="primary"
                          disabled={busy}
                          onClick={() => onDecide([m.index], "accept")}
                        > {uiText("Confirm")} </button>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() => onDecide([m.index], "reject")}
                        > {uiText("Not a transfer")} </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {pendingMatches.length > 1 && (
                <div className="csv-category-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      onDecide(
                        pendingMatches.map((m) => m.index),
                        "accept",
                      )
                    }
                  > {uiText("Confirm all")} {pendingMatches.length}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      onDecide(
                        pendingMatches.map((m) => m.index),
                        "reject",
                      )
                    }
                  > {uiText("None are transfers")} </button>
                </div>
              )}
            </>
          )}
        </section>
      )}
      {!!preview.length && !parseError && (
        <>
          <h3>{uiText("Review transactions")}</h3>
          <p>
            {selected.length} {uiText("selected ·")} {invalidCount} {uiText("invalid ·")}{" "}
            {duplicateCount} {uiText("possible duplicates")} </p>
          <label className="csv-check">
            <input
              type="checkbox"
              disabled={busy || done}
              checked={includeDuplicates}
              onChange={(e) => onSetIncludeDuplicates(e.target.checked)}
            /> {uiText("Include possible duplicates (same account, date, amount and payee)")} </label>
          <label> {uiText("Show rows")} <select value={filter} onChange={(e) => onSetFilter(e.target.value)}>
              <option value="all">{uiText("All rows (")}{preview.length})</option>
              <option value="invalid">{uiText("Invalid fields (")}{invalidCount})</option>
              <option value="duplicates"> {uiText("Possible duplicates (")}{duplicateCount})
              </option>
              <option value="selected">{uiText("Selected (")}{selected.length})</option>
              {matches.length > 0 && (
                <option value="transfers"> {uiText("Transfers found (")}{matches.length})
                </option>
              )}
            </select>
          </label>
          <div className="csv-table">
            <table>
              <thead>
                <tr>
                  <th>{uiText("Include")}</th>
                  <th>{uiText("Row")}</th>
                  <th>{uiText("Date")}</th>
                  <th>{uiText("Payee")}</th>
                  <th>{uiText("Amount")}</th>
                  <th>{uiText("Type / transfer account")}</th>
                  <th>{uiText("Status")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.index}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Include row ${r.index + 1}`}
                        disabled={
                          busy ||
                          done ||
                          !r.transaction ||
                          (r.duplicate && !includeDuplicates)
                        }
                        checked={
                          !!r.transaction &&
                          !excluded.has(r.index) &&
                          (!r.duplicate || includeDuplicates)
                        }
                        onChange={(e) =>
                          onToggleExcluded(r.index, e.target.checked)
                        }
                      />
                    </td>
                    <td>{r.index + skip + (header ? 2 : 1)}</td>
                    <td>
                      {r.transaction?.date ?? data[r.index]?.[options.date] ?? "—"}
                    </td>
                    <td>
                      {r.transaction?.payee ||
                        data[r.index]?.[options.payee] ||
                        "—"}
                    </td>
                    <td>
                      {r.transaction
                        ? money(
                            r.transaction.amount *
                              (r.transaction.type === "expense" ? -1 : 1),
                          )
                        : "—"}
                    </td>
                    <td>
                      <select
                        aria-label={`Transfer account for row ${r.index + skip + (header ? 2 : 1)}`}
                        disabled={busy || done}
                        value={transfers[r.index] ?? ""}
                        onChange={(e) =>
                          onChangeTransfers({
                            ...options.transfers,
                            [r.index]: e.target.value,
                          })
                        }
                      >
                        <option value="">{uiText("Income / expense")}</option>
                        {ledger.accounts
                          .filter((a) => a.id !== options.account)
                          .map((a) => (
                            <option key={a.id} value={a.id}> {uiText("Transfer ·")} {a.name}
                            </option>
                          ))}
                      </select>
                      {r.transaction?.type === "transfer" && (
                        <small>
                          {accountById.get(r.transaction.account_id)?.name} →{" "}
                          {
                            accountById.get(
                              r.transaction.to_account_id ?? "",
                            )?.name
                          }
                        </small>
                      )}
                    </td>
                    <td>
                      {r.error ||
                        (appliedByIndex.has(r.index) ? (
                          <>
                            {matchLabel(appliedByIndex.get(r.index)!)}{" "}
                            <button
                              type="button"
                              className="text-button"
                              disabled={busy || done}
                              onClick={() => onDecide([r.index], "reject")}
                            > {uiText("Not a transfer")} </button>
                          </>
                        ) : matchByIndex.has(r.index) ? (
                          <> {uiText("Possible")}{" "}
                            {matchLabel(matchByIndex.get(r.index)!).replace(
                              /^Transfer|^Already/,
                              (w) => w.toLowerCase(),
                            )}{" "}
                            <button
                              type="button"
                              className="text-button"
                              disabled={busy || done}
                              onClick={() => onDecide([r.index], "accept")}
                            > {uiText("Confirm")} </button>
                          </>
                        ) : r.duplicate ? (
                          "Possible duplicate"
                        ) : (
                          "Ready"
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
