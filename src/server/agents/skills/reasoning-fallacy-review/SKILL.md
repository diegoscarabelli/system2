---
name: reasoning-fallacy-review
description: Use when reviewing analytical work for cognitive biases and reasoning fallacies. Trigger on any review of conclusions, causal claims, risk assessments, forecasts, or interpretive analysis where System 1 thinking may have gone unchecked.
roles: [conductor, reviewer]
---

# Reasoning Fallacy Review

Daniel Kahneman's dual-process model distinguishes System 1 (fast, intuitive, automatic) from System 2 (slow, deliberate, effortful). Most analytical errors arise when System 1 generates intuitive answers that go unchecked. Awareness of a bias does not eliminate it: biases are automatic responses that persist even when consciously recognized. This is why external review matters more than self-awareness.

The sections below are a reference catalog, not a checklist to apply exhaustively. Consider each bias and technique against the specific work under review; not every item will be relevant to every analysis or situation.

---

## Core Biases

### WYSIATI ("What You See Is All There Is")

Drawing confident conclusions from incomplete information.

**In analytical work:** conclusions from a single data source when multiple exist; no mention of unavailable data; treating the dataset at hand as the full picture; confusing "no evidence of X" with "evidence of no X."

**Ask:** What data sources were NOT consulted? Does the analysis acknowledge what is missing? Could a plausible unconsidered source contradict the conclusion?

**Remedy:** Require an explicit "data limitations" section. Ask the analyst to enumerate data sources or perspectives they did not examine, and why.

### Confirmation Bias

Seeking and favoring evidence that confirms existing beliefs while dismissing contradictions.

**In analytical work:** every data point supports the hypothesis with no disconfirming evidence; contradictory findings dismissed as "anomalies"; variable selection or time ranges happen to favor the preferred conclusion; one-tailed tests where two-tailed are appropriate.

**Ask:** What would evidence AGAINST this conclusion look like? Was it looked for? If we assumed the opposite conclusion, what evidence in the data would support it? Were analytical choices (date ranges, filters, variables) locked before results were computed?

**Remedy:** Require a "disconfirmation section" where the analyst steelmans the opposing interpretation. Apply Analysis of Competing Hypotheses: enumerate 2-3 alternative hypotheses and evaluate evidence for each.

### Availability Bias

Judging likelihood based on ease of retrieval rather than actual frequency.

**In analytical work:** disproportionate focus on recent events or dramatic outliers; overweighting anecdotal evidence relative to aggregate data; risk assessments dominated by whatever failure mode is most memorable.

**Ask:** Are the cited examples representative or merely memorable? Is there base-rate data available? Would the assessment change if the most vivid recent example were removed?

**Remedy:** Require base-rate data before accepting probability estimates. Cross-check risk rankings against historical frequency data.

### Anchoring

Over-relying on the first piece of information encountered, which frames all subsequent analysis.

**In analytical work:** projections suspiciously close to last year's figure or an industry benchmark; insufficient adjustment from historical baselines when conditions have changed; sensitivity analyses exploring a narrow range around the anchor.

**Ask:** What was the first number encountered on this topic? How far did the final estimate move from it? If starting from a different reference point, would the conclusion change? Are confidence intervals suspiciously narrow?

**Remedy:** Require estimates built bottom-up from components before comparing to benchmarks. Ask the analyst to produce the estimate twice: once starting from the highest plausible value adjusting down, once from the lowest adjusting up, then reconcile.

### Substitution

Answering an easier question instead of the hard one actually asked.

**In analytical work:** when asked "will this strategy increase market share?" the analyst answers "is this strategy popular with customers?"; proxy metrics used without acknowledging the gap; "what will happen?" replaced with "what has happened before?" without addressing changed conditions.

**Ask:** Does the analysis answer the question that was asked, or a related but different one? Are proxy metrics explicitly identified as proxies with stated limitations? If the stakeholder re-reads their original question after the analysis, would they feel it was answered or sidestepped?

**Remedy:** Restate the original question at the top and check alignment at the end. When substitution is necessary, require the analyst to name it and explain why the proxy is reasonable.

### Narrative Fallacy

Constructing coherent causal stories to explain complex or random events.

**In analytical work:** a clean causal story explaining all observations with no loose ends and no acknowledged randomness; post-hoc explanations that fit perfectly but were not predicted in advance; correlations presented with causal explanations that sound right but have no experimental backing; overfitting.

**Ask:** Is this explanation falsifiable? Was it predicted before the data was seen? How much variance does the model actually explain? Are there simpler explanations (including randomness) that fit equally well? If the data showed the opposite pattern, could an equally compelling narrative be constructed?

**Remedy:** Require quantification of unexplained variance. Demand out-of-sample validation. Ask the analyst to propose at least one alternative causal story that also fits the data. Flag causal language ("caused," "led to," "drove") and check whether causal inference methodology supports it.

### Suppression of Doubt

Preferring false certainty over acknowledged ambiguity.

**In analytical work:** point estimates without ranges; definitive language ("will," "clearly," "certainly") despite genuine ambiguity; absence of caveats; sensitivity analysis missing or perfunctory; binary conclusions for questions that warrant probabilistic answers.

**Ask:** Does every quantitative claim have an uncertainty estimate? What assumptions does the conclusion rest on? How sensitive is the conclusion to violations? Has the analyst acknowledged what would need to be true for this analysis to be wrong?

**Remedy:** Require uncertainty bounds on all quantitative claims. Ban definitive causal language unless supported by experimental design. Require a "conditions for failure" section. Apply the premortem: "Assume this analysis is wrong. Why?"

---

## Additional Biases in Analytical Work

**Survivorship bias:** analyzing only what survived a selection process (successful companies, retained customers) while ignoring failures or dropouts. Ask: does the dataset include failures, or only survivors?

**Base rate neglect:** drawing conclusions from conditional probabilities without accounting for underlying prevalence. A 99%-accurate test for a 0.1%-prevalence condition still produces mostly false positives. Ask: is the base rate incorporated into probabilistic reasoning?

**Simpson's paradox:** a trend that appears in aggregated data reverses when segmented by a confounding variable. Ask: have results been checked at the subgroup level? Could a confounding variable reverse the aggregate finding?

**Ecological fallacy:** inferring individual-level relationships from group-level data. Ask: are group-level statistics being applied to individual-level claims?

**HARKing (Hypothesizing After Results Are Known):** presenting post-hoc hypotheses as pre-specified. Ask: was the hypothesis documented before analysis began? How many tests were run vs. reported?

**Outcome bias:** judging the quality of a past decision by its outcome rather than the quality of reasoning at the time. Ask: is the analysis evaluating the decision process or just the result?

---

## Root Deficiency Analysis

Every bias above traces to one or more fundamental deficiencies. When you detect a reasoning error, name the root deficiency to make the feedback actionable:

| Root Deficiency | Primary Biases | Core Review Question |
| --- | --- | --- |
| Insufficient data | WYSIATI, Survivorship | "What are we NOT seeing?" |
| Insufficient analytical capability | Availability, Anchoring, Substitution, Base Rate Neglect, Simpson's | "Is the method adequate for the question?" |
| Inadequate uncertainty acknowledgement | Narrative Fallacy, Suppression of Doubt | "How wrong could this be?" |
| Selective data exclusion | Confirmation, HARKing, Outcome Bias | "What evidence was left out, and why?" |

---

## Adversarial Review Techniques

Use these structured techniques when reviewing complex analytical work:

**Premortem (Kahneman/Klein):** before finalizing the review, assume the analysis is wrong. Ask: "It is one year from now and this analysis proved completely incorrect. What happened?" Research shows prospective hindsight increases the ability to identify failure reasons by ~30%.

**Analysis of Competing Hypotheses (Heuer, CIA):** enumerate all plausible hypotheses. Build a matrix of evidence vs. hypotheses. Focus on which evidence discriminates between hypotheses, not which confirms the favored one.

**Outside View / Reference Class Forecasting:** before accepting any estimate, identify the reference class of similar past analyses. Compare against the distribution of actual outcomes. Inside-view estimates systematically underperform outside-view estimates.
