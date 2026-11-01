// The diagnosis: which model answered, and what that means for the account.
//
// A Codex account that is moved off the model that was asked for answers with
// a Luna model — that is the sign of the account being held back (风控). Any
// other diagnosis means the account still answers as the model it should.

export function lunaProbability(diagnosis, config) {
  const risk = new Set(config.riskModels.map((id) => id.toLowerCase()));
  return diagnosis.results
    .filter((item) => risk.has(item.model.toLowerCase()))
    .reduce((sum, item) => sum + item.probability, 0);
}

/**
 * verdictOf turns a ModelTrace diagnosis into the monitor's verdict:
 *   risk — the top model is a Luna one, so the account is held back
 *   ok   — the top model is anything else
 * The full distribution is kept beside it, so a marginal call can be read.
 */
export function verdictOf(diagnosis, config) {
  const top = diagnosis.results[0];
  const riskModel = config.riskModels.includes(top.model.toLowerCase());
  return {
    verdict: riskModel ? "risk" : "ok",
    model: top.model,
    displayName: top.display_name,
    probability: top.probability,
    lunaProbability: lunaProbability(diagnosis, config),
    family: diagnosis.family_prediction,
    familyName: diagnosis.family_prediction_name,
    note: riskModel
      ? `${top.display_name} answered instead of the model asked for: the account is held back`
      : `${top.display_name} answered, as the model asked for`,
  };
}

/** topResults trims a diagnosis to what a record needs. */
export function topResults(diagnosis, count = 5) {
  return diagnosis.results.slice(0, count).map((item) => ({
    model: item.model,
    display_name: item.display_name,
    probability: item.probability,
    profile_similarity: item.profile_similarity,
    score: item.score,
  }));
}
