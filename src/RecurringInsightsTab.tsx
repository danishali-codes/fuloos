import { translateText as uiText } from "./i18n";
import type { IntelligentForecast } from "./recurringAutomation.ts";
import { formatShortDate } from "./RecurringView";

export function RecurringInsightsTab({
  forecast,
  concealed,
}: {
  forecast: IntelligentForecast;
  concealed: (v: number) => string;
}) {
  return (
    <div className="recurring-insights-grid">
      <section className="panel section">
        <div className="panel-heading">
          <div>
            <h2>{uiText("30, 60 & 90-day cash flow horizons")}</h2>
            <p> {uiText("Scheduled and predicted recurring payments. Confirmed payments are already recorded and never counted twice.")} </p>
          </div>
        </div>

        <div className="horizon-cards-row">
          {([30, 60, 90] as const).map((h) => {
            const hz = forecast.horizons[h];
            return (
              <div className="horizon-card" key={h}>
                <div className="horizon-head">
                  <b>{uiText("Next")} {h} {uiText("days")}</b>
                  <span>
                    {formatShortDate(hz.fromDate)} –{" "}
                    {formatShortDate(hz.toDate)}
                  </span>
                </div>

                <div className="horizon-metrics">
                  <div className="horizon-metric">
                    <span className="muted">{uiText("Expected expenses")}</span>
                    <strong>−{concealed(hz.expense.expected)}</strong>
                    {hz.expense.low !== hz.expense.high && (
                      <small> {uiText("Range")} {concealed(hz.expense.low)} –{" "}
                        {concealed(hz.expense.high)}
                      </small>
                    )}
                  </div>
                  <div className="horizon-metric">
                    <span className="muted">{uiText("Expected income")}</span>
                    <strong className="green-text">
                      +{concealed(hz.income.expected)}
                    </strong>
                    {hz.income.low !== hz.income.high && (
                      <small> {uiText("Range")} {concealed(hz.income.low)} –{" "}
                        {concealed(hz.income.high)}
                      </small>
                    )}
                  </div>
                  <div className="horizon-metric net">
                    <span className="muted">{uiText("Net recurring")}</span>
                    <strong
                      className={hz.net.expected >= 0 ? "green-text" : ""}
                    >
                      {hz.net.expected >= 0 ? "+" : "−"}
                      {concealed(Math.abs(hz.net.expected))}
                    </strong>
                    <small>
                      {hz.unconfirmedCount} {uiText("payment")} {hz.unconfirmedCount === 1 ? "" : "s"} {uiText("expected")} </small>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel section">
        <div className="panel-heading">
          <div>
            <h2>{uiText("Projected account balances")}</h2>
            <p> {uiText("Current ledger balances adjusted for scheduled payments. Recorded balances stay untouched until you confirm.")} </p>
          </div>
        </div>

        <div className="projected-table-wrap">
          <table className="projected-table">
            <thead>
              <tr>
                <th>{uiText("Account")}</th>
                <th>{uiText("Current balance")}</th>
                <th>{uiText("Scheduled 30d delta")}</th>
                <th>{uiText("Projected (30d)")}</th>
                <th>{uiText("Projected (60d)")}</th>
                <th>{uiText("Projected (90d)")}</th>
              </tr>
            </thead>
            <tbody>
              {forecast.accountProjections.map((ap) => (
                <tr key={ap.account.id}>
                  <td>
                    <b>{ap.account.name}</b>
                  </td>
                  <td>{concealed(ap.currentBalance)}</td>
                  <td>
                    <span
                      className={
                        ap.horizons[30].scheduledDelta >= 0
                          ? "green-text"
                          : ""
                      }
                    >
                      {ap.horizons[30].scheduledDelta >= 0 ? "+" : "−"}
                      {concealed(Math.abs(ap.horizons[30].scheduledDelta))}
                    </span>
                  </td>
                  <td>
                    <b
                      className={
                        ap.horizons[30].projectedBalance < 0 ? "red-text" : ""
                      }
                    >
                      {concealed(ap.horizons[30].projectedBalance)}
                    </b>
                    {ap.horizons[30].hasRange && (
                      <small className="cell-sub">
                        ({concealed(ap.horizons[30].lowBalance)} –{" "}
                        {concealed(ap.horizons[30].highBalance)})
                      </small>
                    )}
                  </td>
                  <td>
                    <b
                      className={
                        ap.horizons[60].projectedBalance < 0 ? "red-text" : ""
                      }
                    >
                      {concealed(ap.horizons[60].projectedBalance)}
                    </b>
                  </td>
                  <td>
                    <b
                      className={
                        ap.horizons[90].projectedBalance < 0 ? "red-text" : ""
                      }
                    >
                      {concealed(ap.horizons[90].projectedBalance)}
                    </b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel section monthly-commitment-panel">
        <div className="panel-heading">
          <div>
            <h2>{uiText("Monthly recurring commitment breakdown")}</h2>
            <p>{uiText("Analysis of fixed commitments vs variable estimated bills")}</p>
          </div>
        </div>

        <div className="commitments-breakdown-row">
          <div className="commitment-stat-box">
            <span className="muted">{uiText("Fixed expenses / mo")}</span>
            <strong>{concealed(forecast.monthlyCommitment.fixedExpense)}</strong>
            <small>{uiText("Subscriptions, rent & contracts")}</small>
          </div>
          <div className="commitment-stat-box">
            <span className="muted">{uiText("Variable expenses / mo")}</span>
            <strong>
              {concealed(forecast.monthlyCommitment.variableExpense)}
            </strong>
            <small>{uiText("Estimated utilities & fluctuating bills")}</small>
          </div>
          <div className="commitment-stat-box">
            <span className="muted">{uiText("Total recurring expenses / mo")}</span>
            <strong>{concealed(forecast.monthlyCommitment.totalExpense)}</strong>
            <small>{uiText("Combined monthly commitment")}</small>
          </div>
          <div className="commitment-stat-box">
            <span className="muted">{uiText("Annualized recurring expenses")}</span>
            <strong>
              {concealed(forecast.monthlyCommitment.annualizedExpense)}
            </strong>
            <small>{uiText("12-month recurring expenditure")}</small>
          </div>
        </div>
      </section>
    </div>
  );
}
