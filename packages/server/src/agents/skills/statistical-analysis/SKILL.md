---
name: statistical-analysis
description: Use when performing or reviewing quantitative analysis, choosing statistical tests, checking assumptions, interpreting results, or conducting Bayesian modeling. Trigger on any work involving hypothesis testing, effect sizes, confidence/credible intervals, regression, or statistical reporting.
roles: [conductor, reviewer]
---

# Statistical Analysis

This skill covers both frequentist and Bayesian methodology. Use it when performing quantitative analysis, selecting statistical methods, checking assumptions, interpreting results, or reviewing analytical work for methodological rigor.

Key references: ASA Statement on P-Values (Wasserstein & Lazar, 2016), *Bayesian Data Analysis* 3rd ed. (Gelman et al., 2013), *Statistical Rethinking* 2nd ed. (McElreath, 2020), APA 7th Edition reporting standards.

---

## 1. Analysis Workflow

Follow this sequence when performing or reviewing statistical analysis. Each step references the relevant deep-dive section.

1. **Define the question.** Descriptive, inferential, predictive, or causal? The question type constrains which methods are valid (Section 2).
2. **Plan before analyzing.** Document: primary outcome, secondary outcomes, covariates, exclusion criteria, planned tests, alpha level. Understand the data generating process (how data was collected, sampled, measured). Separate confirmatory from exploratory analyses.
3. **Characterize the data.** Variable types (nominal, ordinal, interval, ratio), sample size per group, independence structure (nested, clustered, repeated measures), missingness patterns (Section 7). Visualize distributions (histograms, Q-Q plots, boxplots). Identify outliers using domain knowledge, not just statistical cutoffs.
4. **Check assumptions** (Section 4). Normality, homoscedasticity, independence, linearity, multicollinearity as applicable. Note violations and select robust alternatives.
5. **Select and run the method.** Use the test selection tables (Section 3). State why this method fits the data structure and question. Check diagnostics: frequentist assumptions (Section 5) or Bayesian MCMC workflow (Section 6).
6. **Report fully.** Every quantitative finding needs: the test used and why, sample size per group, point estimate with uncertainty (CI or CrI), effect size with domain-context interpretation, assumption checks performed, multiple comparison correction if applicable.
7. **Flag limitations.** Which assumptions are most fragile? What alternative analyses would be informative? What would need to be true for this conclusion to be wrong?
8. **Anti-pattern scan** (Section 11). P-hacking, multiple comparisons, Simpson's paradox, base rate neglect, survivorship bias, ecological fallacy, regression to the mean, overfitting.

### Reporting format by analysis type

| Analysis | Report |
| --- | --- |
| t-test | t(df) = value, p = value, d = value [95% CI] |
| ANOVA | F(df1, df2) = value, p = value, eta-squared = value |
| Chi-squared | chi-squared(df) = value, p = value, Cramer's V |
| Regression | Coefficient table (B, SE, beta, t, p), R-squared (adjusted), F-test |
| Bayesian | Posterior mean/median, 95% CrI, pd, MCMC diagnostics |

**General formatting (APA 7th Edition):** exact p-values to three decimals (p = .032, except p < .001), effect sizes with CIs for all key findings, descriptive statistics (M, SD, n) per group, 2 decimal places (3 for p-values). Tables for complex results, figures for patterns and interactions.

**Contextual standards:** STROBE for observational studies, CONSORT for randomized trials, PRISMA for systematic reviews and meta-analyses (Section 10).

---

## 2. Choosing Between Frequentist and Bayesian

Neither framework is universally superior. The choice depends on the question, the data, and the inferential goal.

### Frequentist: use when

- The goal is binary decision-making with controlled error rates (A/B testing, clinical trials with fixed sample)
- Regulatory or publication norms require it (FDA submissions, many journals)
- Prior information is absent, contentious, or you want results independent of prior choice
- Computational simplicity matters for large-scale testing (thousands of simultaneous tests)
- The problem fits Neyman-Pearson hypothesis testing cleanly

### Bayesian: use when

- You want direct probability statements about parameters ("95% probability the effect is in this interval")
- Meaningful prior information exists (previous studies, domain expertise, physical constraints)
- Sequential analysis: updating beliefs as data arrives without inflating error rates
- Small samples where regularization via priors prevents overfitting
- Complex hierarchical or multilevel models (Bayesian computation handles these naturally)
- The question is about effect magnitude, not just "is it zero?"
- Model comparison between non-nested models (Bayes factors, LOO-CV)

### When results converge

For routine analyses (t-tests, ANOVA, regression) with vague priors and moderate samples, frequentist and Bayesian results are nearly identical. In these cases the choice is pragmatic. For complex models, small samples, or strong prior information, the frameworks can diverge meaningfully.

---

## 3. Statistical Test Selection

### Comparing groups

**Two groups, continuous outcome:**

| Scenario | Test |
| --- | --- |
| Independent, normal, equal variance | Independent samples t-test |
| Independent, normal, unequal variance | Welch's t-test (prefer as default) |
| Independent, non-normal or ordinal | Mann-Whitney U |
| Paired/matched, normal | Paired t-test |
| Paired/matched, non-normal | Wilcoxon signed-rank |

**Three+ groups, continuous outcome:**

| Scenario | Test | Post-hoc |
| --- | --- | --- |
| Independent, normal, equal variance | One-way ANOVA | Tukey HSD |
| Independent, non-normal or ordinal | Kruskal-Wallis | Dunn's test |
| Repeated measures, normal | Repeated-measures ANOVA | Bonferroni-corrected pairwise |
| Repeated measures, non-normal | Friedman test | Nemenyi |

Check sphericity for repeated-measures ANOVA (Mauchly's test); apply Greenhouse-Geisser correction if violated.

**Categorical outcomes:**

| Scenario | Test |
| --- | --- |
| Two categorical variables, large samples | Chi-squared test of independence (expected counts >= 5) |
| Two categorical variables, small samples | Fisher's exact test |
| Paired categorical | McNemar's test |
| Ordinal outcome with group comparison | Ordered logistic regression or Mann-Whitney |

### Associations and predictions

| Scenario | Method |
| --- | --- |
| Two continuous, linear relationship | Pearson correlation |
| Two continuous, non-linear or ordinal | Spearman rank correlation |
| Continuous outcome, mixed predictors | Linear regression (OLS) |
| Binary outcome | Logistic regression |
| Count outcome | Poisson or negative binomial regression |
| Time-to-event | Cox proportional hazards, Kaplan-Meier |
| Clustered/nested data | Mixed-effects (multilevel) models |
| High-dimensional predictors | Regularized regression (LASSO, Ridge, Elastic Net) |
| Non-linear relationships | GAMs (generalized additive models) |

**Before selecting a test, always verify:** (1) outcome variable type, (2) predictor types and count, (3) independence structure, (4) distributional assumptions.

---

## 4. Assumption Checking

### Normality

- **Visual (preferred):** Q-Q plot. Histograms as supplement.
- **Formal tests:** Shapiro-Wilk (best for n < 50), Anderson-Darling, Kolmogorov-Smirnov (less powerful).
- **Nuance:** With large n, formal tests reject trivial deviations. With small n, they lack power to detect real non-normality. Visual inspection is more informative in practice.
- **If violated:** Non-parametric alternatives, transformations (log, sqrt, Box-Cox), or rely on CLT if n is large enough (~30+ per group for means, but this is a guideline, not a law).
- **Robustness:** t-tests and ANOVA are robust to moderate non-normality with balanced designs and decent sample sizes. Skewness matters more than kurtosis.

### Homoscedasticity (equal variances)

- **Visual:** Residuals vs. fitted values (look for fan/funnel shapes).
- **Formal tests:** Levene's test (robust to non-normality), Bartlett's test (sensitive to non-normality), Breusch-Pagan (regression).
- **If violated:** Welch's t-test (always prefer over Student's t-test), heteroscedasticity-robust standard errors (HC3 for small samples, HC1 for large), weighted least squares, or transform the outcome.

### Independence

- **Cannot be tested statistically in most cases; must be assessed from the study design.**
- Common violations: repeated measures, clustered data (students within schools, employees within companies), time series autocorrelation, spatial correlation.
- **If violated:** Mixed-effects models, GEE, clustered standard errors, time series methods (ARIMA, etc.).
- **Consequence of ignoring:** Inflated Type I error, often severely. This is the most dangerous assumption to violate.

### Linearity (regression)

- **Visual:** Scatterplots of outcome vs. each predictor; residuals vs. fitted; partial regression plots; component-plus-residual plots.
- **If violated:** Polynomial terms, splines, GAMs, or non-linear models.

### Multicollinearity (multiple regression)

- **Diagnostic:** VIF > 5 is concerning, > 10 is problematic. Also check condition number and pairwise correlations.
- **If present:** Remove or combine collinear predictors, use regularization (Ridge), or use PCA/factor analysis to create orthogonal composites.
- **Consequence:** Coefficient estimates become unstable (large standard errors, sign flips), though predictions may remain fine.

### Summary table

| Assumption | Applies to | Violation consequence | Check with |
| --- | --- | --- | --- |
| Normality of residuals | Regression, t-tests, ANOVA | Biased CIs and p-values (small samples) | Q-Q plot, Shapiro-Wilk |
| Homoscedasticity | Regression, ANOVA | Biased standard errors | Residual-vs-fitted plot, Breusch-Pagan, Levene's |
| Independence | Most parametric tests | Inflated Type I error (severe) | Study design review, Durbin-Watson |
| Linearity | Linear regression | Biased estimates | Residual plots, component-plus-residual plots |
| No multicollinearity | Multiple regression | Unstable coefficients | VIF, condition number |

---

## 5. Frequentist Analysis: Key Principles

### P-values (ASA Statement, 2016)

A p-value measures incompatibility between the data and a statistical model (typically the null hypothesis). It is not the probability that the hypothesis is true or false.

**Rules:**
- Report exact p-values (p = 0.032, not "p < 0.05"), except for very small values (p < 0.001)
- Never write "p = 0.000"; report as p < 0.001
- Do not treat p = 0.049 and p = 0.051 as categorically different
- "Not statistically significant" does not mean "no effect"
- State whether tests are one-sided or two-sided and justify the choice
- Avoid "trending toward significance" to salvage p = 0.06-0.10
- Never use the word "proves"; p-values cannot prove anything

### Effect sizes

Statistical significance tells you the effect is unlikely to be exactly zero. Effect size tells you whether it matters. With large samples, trivially small effects become "significant."

**Always report for key findings:**

| Context | Measure | Cohen's benchmarks |
| --- | --- | --- |
| Two-group mean difference | Cohen's d | 0.2 / 0.5 / 0.8 |
| ANOVA | Eta-squared (partial) | 0.01 / 0.06 / 0.14 |
| Correlation | r | 0.1 / 0.3 / 0.5 |
| Binary outcome | Odds ratio, relative risk, NNT | Context-dependent |
| Regression | R-squared, standardized beta | Context-dependent |

**Cohen's benchmarks are rough guidelines from behavioral science, not universal thresholds.** A "small" effect in one domain may be large in another. Always interpret effect sizes in the substantive domain context.

### Confidence intervals

- Report 95% CIs for all key estimates
- Correct interpretation: "If we repeated this procedure many times, 95% of the intervals would contain the true parameter." It does NOT mean there is a 95% probability THIS interval contains the truth.
- Discuss CI width in terms of practical implications
- A CI spanning the null value (0 for differences, 1 for ratios) undermines claims of a directional effect
- Extremely wide CIs signal low precision regardless of statistical significance

### Multiple comparisons

With k independent tests at alpha = 0.05, the probability of at least one false positive is 1 - (0.95)^k. At k = 20, that is 64%.

| Method | Controls | Best for |
| --- | --- | --- |
| Bonferroni | Family-wise error rate | Small number of planned comparisons; confirmatory work |
| Holm-Bonferroni | Family-wise error rate | Same, but uniformly more powerful than Bonferroni |
| Benjamini-Hochberg | False discovery rate | Exploratory work; large number of tests |

**Always state:** how many tests were conducted (including unreported ones), which correction was applied and why.

### Power analysis

- Conduct a priori, not post-hoc (post-hoc power is circular and uninformative)
- Justify the target effect size from prior work or practical significance thresholds, not Cohen's "medium" default
- Standard target: 80% power (beta = 0.20). For critical decisions, consider 90%
- For null results: was the study sufficiently powered to detect a meaningful effect? Absence of evidence is not evidence of absence when underpowered
- Report: target effect size, alpha, power, and resulting required n

---

## 6. Bayesian Analysis Workflow

Based on Gelman et al. (2020), "Bayesian Workflow," and McElreath (2020), *Statistical Rethinking*.

### Step 1: Specify the generative model

Write out the full model: likelihood (data model) and priors (parameter model). Every parameter gets a prior.

**Prior selection guidelines:**

| Parameter type | Recommended weakly informative prior | Rationale |
| --- | --- | --- |
| Regression intercept | Normal(mean_y, 2 * sd_y) | Centers on data scale |
| Regression slopes (standardized) | Normal(0, 1) to Normal(0, 2.5) | Regularizes without strong constraint |
| Scale/variance parameters | Half-Normal(0, s) or Half-Cauchy(0, 2.5) | Constrains to positive, weakly informative |
| Correlation matrices | LKJ(2) | Weakly favors lower correlations |
| Probabilities | Beta(1, 1) or Beta(2, 2) | Uniform or weakly regularized |
| Counts | Gamma or Exponential | Match parameter support |

**Prior categories:**
- **Informative priors:** Encode specific domain knowledge. Appropriate when prior studies or expert knowledge provide strong constraints. Must be justified.
- **Weakly informative priors:** Constrain parameters to plausible ranges without dominating the likelihood. Recommended default.
- **Non-informative/flat priors:** Rarely truly non-informative (can be informative on transformed scales). Avoid unless there is a specific reason.

### Step 2: Prior predictive checking

Simulate data from priors alone (before seeing real data). Ask: "Do these priors generate data that looks remotely plausible?" If the prior implies implausible outcomes (negative heights, growth rates of 10,000%), tighten the priors. This step catches misspecified priors before they distort inference.

### Step 3: Fit the model

Standard computational approaches:
- **MCMC via HMC/NUTS:** Stan (brms, rstanarm, cmdstanpy), PyMC, NumPyro, Turing.jl. Gold standard for most models.
- **Variational inference:** Faster but approximate. Useful for initial exploration or very large datasets. Do not rely on for final inference without checking against MCMC.
- **Analytical posteriors:** For conjugate models (Normal-Normal, Beta-Binomial, Gamma-Poisson). Fast and exact when applicable.

### Step 4: MCMC diagnostics (mandatory)

**Do not interpret results from a model with diagnostic failures.**

| Diagnostic | Target | What it means |
| --- | --- | --- |
| R-hat (Gelman-Rubin) | < 1.01 | Chains have converged to the same distribution |
| Bulk ESS | > 400 (ideally > 1000) | Effective sample size for central tendency estimates |
| Tail ESS | > 400 (ideally > 1000) | Effective sample size for interval estimates |
| Divergent transitions | 0 | Sampler navigated the posterior geometry correctly |
| Tree depth | Below max | Sampler did not hit iteration ceiling |

**Trace plots:** Chains should look like "hairy caterpillars" (well-mixed, stationary). Watch for: stuck chains, trending, multimodality, periodic patterns.

**When diagnostics fail:**
- Divergences: reparameterize (non-centered parameterization for hierarchical models), increase `adapt_delta`
- Low ESS: run longer chains, reparameterize, check for multimodality
- High R-hat: run longer chains, check for label switching in mixture models, simplify the model

### Step 5: Posterior predictive checking

Simulate new data from the fitted model. Compare simulated data to observed data visually and with summary statistics. Systematic discrepancies reveal model misspecification (wrong likelihood, missing predictors, ignored structure).

### Step 6: Summarize and interpret

**Credible intervals:**
- **Highest Density Interval (HDI):** narrowest interval containing 95% of posterior mass. Preferred when the posterior is skewed.
- **Equal-Tailed Interval (ETI):** 2.5th to 97.5th percentile. Easier to compute, fine for symmetric posteriors.
- Correct interpretation: "Given the data and model, there is a 95% probability the parameter lies in this interval." This IS the probabilistic statement people usually want (unlike frequentist CIs).

**Region of Practical Equivalence (ROPE):**
Define a range around zero (or another null value) representing "negligible effect." Decision rules:
- 95% HDI entirely outside ROPE: conclude meaningful effect
- 95% HDI entirely inside ROPE: conclude practical equivalence to null
- 95% HDI overlapping ROPE: inconclusive, collect more data or accept uncertainty

**Probability of direction (pd):** The proportion of the posterior that is positive (or negative). Ranges from 50% (no evidence of direction) to 100% (all posterior mass on one side). A useful complement to intervals.

**Bayes factors:**
Quantify relative evidence for one model/hypothesis over another. BF10 denotes evidence for the alternative hypothesis relative to the null.

| BF10 | Interpretation (Kass & Raftery) |
| --- | --- |
| < 1 | Favors null |
| 1-3 | Barely worth mentioning |
| 3-20 | Positive evidence for alternative |
| 20-150 | Strong evidence for alternative |
| > 150 | Very strong evidence for alternative |

Bayes factors are sensitive to prior specification. Always conduct sensitivity analysis when reporting them.

**Model comparison alternatives:**
- **LOO-CV (Leave-One-Out Cross-Validation):** Via Pareto-smoothed importance sampling (PSIS-LOO). Preferred for predictive model comparison. Report ELPD differences with standard errors.
- **WAIC:** Asymptotically equivalent to LOO-CV but less robust. Use LOO-CV when available.

### Step 7: Sensitivity analysis (mandatory)

Re-run the model with different plausible priors for key parameters. If conclusions change substantially, the data are not informative enough to overcome prior choice, and this must be reported. Sensitivity analysis is not optional for Bayesian work.

---

## 7. Missing Data

Missing data is present in virtually every real dataset. How it is handled can bias results as severely as a wrong statistical test.

### Missing data mechanisms

| Mechanism | Meaning | Example | Safe methods |
| --- | --- | --- | --- |
| MCAR (Missing Completely At Random) | Missingness unrelated to any variable | Sensor randomly fails | Listwise deletion (unbiased but loses power), any imputation |
| MAR (Missing At Random) | Missingness depends on observed variables | Higher earners skip income question, but you have education | Multiple imputation, FIML, inverse probability weighting |
| MNAR (Missing Not At Random) | Missingness depends on the missing value itself | Sickest patients drop out of a trial | No general fix; requires modeling the missingness mechanism (selection models, pattern-mixture models) |

### Methods

- **Listwise deletion (complete cases):** Simple but loses data. Unbiased only under MCAR. With 10 variables each 5% missing independently, ~40% of rows are dropped.
- **Mean/median imputation:** Destroys variance and covariance structure. Almost never appropriate for inferential work.
- **Multiple imputation (MI):** Creates m imputed datasets (typically 20-50), analyzes each, pools results using Rubin's rules. Valid under MAR. The standard for most applications.
- **Full Information Maximum Likelihood (FIML):** Estimates parameters using all available data without imputing. Equivalent to MI asymptotically. Common in SEM.
- **Inverse probability weighting (IPW):** Weights complete cases by the inverse probability of being observed. Useful when the missingness model is well-understood.

### Red flags

- No discussion of missing data at all
- Missing data "cleaned" by dropping rows without assessing the mechanism
- Single imputation (mean, median, last-observation-carried-forward) used for inference
- MNAR treated as MAR without sensitivity analysis
- Fraction of missing data not reported

---

## 8. Bootstrap Methods

When parametric assumptions are questionable and full Bayesian modeling is impractical, bootstrap provides distribution-free inference.

### Core idea

Resample the observed data with replacement (B times, typically B >= 2000 for CIs), compute the statistic of interest on each resample, and use the empirical distribution of the statistic for inference.

### Variants

| Method | Use case | Notes |
| --- | --- | --- |
| Non-parametric bootstrap | General-purpose | Resample observations with replacement |
| Parametric bootstrap | When model is trusted but sampling distribution is complex | Simulate from fitted model |
| Block bootstrap | Time series, clustered data | Resample blocks to preserve dependence structure |
| Wild bootstrap | Heteroscedastic regression | Perturbs residuals; better than pairs bootstrap for small n |
| Bayesian bootstrap | Bayesian-flavored inference without priors | Reweight observations with Dirichlet weights |

### Bootstrap confidence intervals

- **Percentile method:** Simple but biased for skewed distributions.
- **BCa (Bias-Corrected and Accelerated):** Corrects for bias and skewness. Preferred for most applications.
- **Bootstrap-t:** Studentizes before bootstrapping. Best coverage properties but requires variance estimates per resample.

### When bootstrap fails

- Very small samples (n < 15): the resample distribution is too discrete
- Statistics that depend on extreme order statistics (e.g., max, min)
- Heavy-tailed distributions where the statistic has infinite variance
- Dependent data without appropriate blocking

---

## 9. Time Series Analysis

### Core concepts

Time series data violates the independence assumption of most standard tests. Observations are correlated with their own past values (autocorrelation), and many series exhibit trends, seasonality, or structural breaks.

### Stationarity

Most classical time series methods require (weak) stationarity: constant mean, constant variance, autocovariance that depends only on lag.

- **Visual check:** Plot the series. Trends, changing variance, or seasonal patterns indicate non-stationarity.
- **Formal tests:** Augmented Dickey-Fuller (ADF) tests for unit root (null: non-stationary). KPSS tests for stationarity (null: stationary). Use both: if ADF rejects and KPSS does not, conclude stationarity.
- **Achieving stationarity:** Differencing (first difference for trend, seasonal differencing for seasonality), detrending, or transformation (log for multiplicative seasonality).

### Classical models

| Model | Use case | Key assumptions |
| --- | --- | --- |
| AR(p) | Current value depends on p past values | Stationary |
| MA(q) | Current value depends on q past errors | Stationary |
| ARMA(p,q) | Combination of AR and MA | Stationary |
| ARIMA(p,d,q) | ARMA after d differences | Can handle trend |
| SARIMA(p,d,q)(P,D,Q)s | ARIMA with seasonal component | Can handle trend + seasonality |
| VAR | Multiple interrelated time series | Stationary, all series at same frequency |

**Model selection:** Use ACF/PACF plots for initial order identification. AIC/BIC for formal comparison. Always check residual diagnostics (Ljung-Box test for remaining autocorrelation, normality of residuals).

### Modern approaches

- **Exponential smoothing (ETS):** State-space models. Good for forecasting with trend and seasonality. Holt-Winters is the best-known variant.
- **Prophet / structural time series:** Decompose into trend + seasonality + holidays + error. Accessible and interpretable.
- **GARCH:** Models time-varying volatility (variance clustering). Essential for financial data.
- **Granger causality:** Tests whether past values of X improve predictions of Y beyond Y's own past. Not true causation, but useful for temporal precedence.

### Common pitfalls

- **Spurious regression:** Two non-stationary series will often show high R-squared and significant coefficients even with no real relationship. Always check for cointegration (Engle-Granger, Johansen) or use differenced series.
- **Treating time series as cross-sectional:** Ignoring autocorrelation inflates Type I error. Standard regression on time series data without accounting for serial correlation produces unreliable standard errors.
- **Seasonality mistaken for trend:** A seasonal peak can look like growth if the window is too short.
- **Lookahead bias in forecasting:** Using future information to construct features or select models. Train/test split must respect temporal order (no random splits).

### Forecasting evaluation

- **Train/test split:** Always temporal (not random). Use expanding or sliding window cross-validation.
- **Metrics:** MAE, RMSE, MAPE (beware: MAPE is undefined when actuals are zero, biased toward under-forecasting), MASE (scale-independent, compares to naive forecast).
- **Baselines:** Always compare against a naive forecast (last value, seasonal naive, or historical mean). A model that cannot beat naive is not useful.

---

## 10. Meta-Analysis

Meta-analysis combines results from multiple independent studies to estimate an overall effect, increase statistical power, and assess heterogeneity across studies.

### When to use

- Multiple studies address the same question with compatible outcome measures
- Individual studies may be underpowered but collectively informative
- You want to quantify between-study variability, not just average effect

### Effect size computation

Convert each study's results to a common effect size metric before combining:

| Original metric | Convert to | Formula notes |
| --- | --- | --- |
| Two-group means + SDs | Cohen's d or Hedges' g | Hedges' g corrects small-sample bias in d |
| 2x2 table | Log odds ratio or log risk ratio | Log scale for normality of sampling distribution |
| Correlation | Fisher's z | Stabilizes variance; back-transform for reporting |
| Regression coefficient | Standardized beta or partial r | Requires consistent covariate sets across studies |

### Models

**Fixed-effect model:** Assumes all studies estimate the same true effect. Weights by inverse variance. Appropriate only when studies are functionally identical (same population, design, intervention).

**Random-effects model (DerSimonian-Laird, REML):** Assumes true effects vary across studies. Adds a between-study variance component (tau-squared). Almost always more appropriate in practice, since studies differ in populations, methods, and contexts. Produces wider CIs than fixed-effect, which is honest about the uncertainty.

**Bayesian meta-analysis:** Places priors on the overall effect, between-study variance, and optionally study-level effects. Natural for small numbers of studies where tau-squared estimation is imprecise. Can incorporate informative priors from domain knowledge.

### Heterogeneity

Heterogeneity quantifies how much the effect varies across studies beyond sampling error.

| Statistic | Interpretation |
| --- | --- |
| Q statistic | Tests whether heterogeneity > 0 (low power with few studies) |
| I-squared | Percentage of total variability due to between-study heterogeneity. 25%/50%/75% = low/moderate/high (Higgins & Thompson). Note: I-squared depends on study precision, not just true heterogeneity. |
| tau-squared | Absolute between-study variance on the effect-size scale. More interpretable than I-squared for understanding practical impact. |
| Prediction interval | Range within which the true effect of a NEW study is expected to fall. More useful than the CI of the pooled estimate for practical decisions. |

**When heterogeneity is high:** Do not just report the pooled estimate. Investigate sources via subgroup analysis or meta-regression (study-level covariates that predict effect variation: dosage, population age, measurement instrument, study quality).

### Publication bias

Studies with significant results are more likely to be published, biasing meta-analytic estimates upward.

**Detection:**
- **Funnel plot:** Plot effect size vs. precision (1/SE). Asymmetry suggests publication bias (small studies disproportionately show large effects).
- **Egger's test:** Formal test for funnel plot asymmetry.
- **Trim-and-fill:** Imputes "missing" studies to symmetrize the funnel. Provides an adjusted estimate.
- **p-curve / p-uniform:** Analyze the distribution of significant p-values. A right-skewed p-curve suggests genuine effects; a flat or left-skewed curve suggests p-hacking or bias.

**Sensitivity analysis:**
- **Fail-safe N (Rosenthal):** How many null studies would be needed to make the pooled effect non-significant? High N suggests robustness. Crude but intuitive.
- **Selection models (Vevea-Hedges, Copas):** Explicitly model the probability of publication as a function of p-value. More principled than trim-and-fill.

### Reporting (PRISMA)

- PRISMA flow diagram showing study identification, screening, eligibility, and inclusion
- Forest plot with study-level and pooled estimates
- Heterogeneity statistics (Q, I-squared, tau-squared, prediction interval)
- Publication bias assessment
- Sensitivity analyses (leave-one-out, influence diagnostics, subgroup analyses)

### Common pitfalls

- **Apples and oranges:** Combining studies that measure fundamentally different constructs. Heterogeneity statistics help detect this, but judgment is required.
- **Garbage in, garbage out:** A meta-analysis of biased studies produces a precise but biased estimate. Always assess study quality (risk of bias tools: Cochrane RoB 2, Newcastle-Ottawa).
- **Vote counting:** Counting significant vs. non-significant studies instead of combining effect sizes. This is not meta-analysis; it is misleading.
- **Ignoring heterogeneity:** Reporting only the pooled estimate without prediction intervals when I-squared is high gives a false sense of precision about what to expect in new contexts.
- **Ecological inference:** The pooled between-study effect does not necessarily reflect within-study (individual-level) relationships.

---

## 11. Common Anti-Patterns

### P-hacking and the garden of forking paths

Running multiple tests, adding/removing covariates, trying different variable transformations, or splitting data in different ways until p < 0.05. Each analytical choice is a "fork" that inflates false positive rates even without conscious manipulation.

**Detection:** Hypotheses that suspiciously match results perfectly; only significant results reported from a battery; analytical choices (date ranges, filters, covariates) that happen to favor the conclusion; one-tailed tests where two-tailed are appropriate.

### Multiple comparisons without correction

With 20 independent tests at alpha = 0.05, there is a 64% chance of at least one false positive. Always apply correction (Bonferroni/Holm for confirmatory, Benjamini-Hochberg for exploratory) and report the total number of tests conducted.

### Simpson's paradox

An association that reverses direction when data is stratified by a confounding variable. Whenever reporting aggregate associations, check whether the relationship holds within meaningful subgroups.

### Base rate neglect

Interpreting conditional probabilities without accounting for prevalence. A 99% accurate test for a 1% prevalence condition yields only ~50% positive predictive value. Always compute and report PPV/NPV alongside sensitivity/specificity.

### Correlation as causation

Observational associations do not establish causal effects. Causal language ("causes," "leads to," "drives") requires causal methodology: randomized experiments, instrumental variables, difference-in-differences, regression discontinuity, or at minimum a clearly articulated causal model (DAG) with adequate adjustment for confounders.

### Ecological fallacy

Inferring individual-level relationships from group-level data. Country-level correlations do not describe individual behavior.

### Survivorship bias

Analyzing only cases that survived a selection process (successful companies, retained customers, published studies). Always ask whether the dataset excludes failures, dropouts, or filtered cases.

### Regression to the mean

Extreme values on first measurement tend to be less extreme on re-measurement, purely due to random variation. In pre-post designs without a control group, apparent improvements may be regression to the mean, not treatment effects.

### Confusing statistical and practical significance

A large sample can make trivially small effects statistically significant. Always contextualize: "Is this effect large enough to matter?" Consider minimum important differences, cost-benefit thresholds, or equivalence bounds.

### Overfitting

A model that fits the training data very well but fails on new data. Signs: high R-squared with many predictors relative to n, unstable coefficients, poor cross-validation performance. Remedies: regularization, cross-validation, simpler models, out-of-sample testing.

---

## 12. Causation and Confounding

### Causal inference hierarchy (strongest to weakest)

1. **Randomized controlled experiment:** Gold standard. Random assignment eliminates confounders.
2. **Natural experiment / quasi-experiment:** Exploits as-if random variation (regression discontinuity, instrumental variables, difference-in-differences).
3. **Observational study with adjustment:** Statistical control for measured confounders (propensity score matching, inverse probability weighting, multivariable regression). Cannot address unmeasured confounders.
4. **Observational study without adjustment:** Correlation only. No causal claims.

### Directed Acyclic Graphs (DAGs)

Use DAGs to make causal assumptions explicit. A DAG shows:
- Which variables cause which
- Which paths are causal vs. confounding
- Which variables to adjust for (and which NOT to adjust for, to avoid collider bias)

**Collider bias:** Conditioning on a common effect of two variables creates a spurious association between them. Adjusting for a collider opens a non-causal path. This is a common but under-recognized error.

### Minimum requirements for causal claims from observational data

- A plausible causal model (DAG or equivalent) is stated
- Confounders are identified and adjusted for
- Sensitivity analysis for unmeasured confounding is conducted
- Alternative explanations are discussed
- Language reflects the design: "associated with" not "caused"

