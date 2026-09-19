# I Added a Cheap Decision Model Before Claude. At First, It Cost More.

AI code review can be expensive. Pull requests contain important logic mixed with formatting, generated files, comments, tests, and mechanical changes. Sending everything to a frontier model consumes tokens whether each line deserves attention or not.

I built **prune-review** to test a simple idea:

> Can a fast, inexpensive decision model reduce the context sent to Claude without weakening the review?

## My First Attempt Failed

The pipeline used **Jev, TypeSafe's System One model**, to classify pull-request hunks before sending selected context to Claude:

`PR diff -> Jev decisions -> filtered diff -> Claude review`

It sounded economical. My first 11-PR benchmark showed the opposite:

**The routed path cost 32% more than sending the full diff directly to Claude.**

Jev was not the problem. Its total cost was tiny. My routing rules were too conservative, so almost every hunk survived.

Claude was also running as an unrestricted coding agent. Even when I supplied a smaller prompt, it could inspect the repository and load much more context. In one experiment, a prepared prompt of roughly 21,000 characters expanded into **1.2 million Claude prompt tokens**.

I had reduced the initial input, but not controlled the execution boundary.

## Simplifying the Pipeline

I made three important changes.

### 1. Classify the Whole PR Together

Instead of sending each hunk to Jev independently, I sent all changed hunks in one structured request.

For every hunk, Jev answered two focused questions:

- Could omitting this hunk hide an actionable defect?
- Is this hunk required to understand another changed hunk?

This allowed Jev to retain related implementation and test context without keeping every behavioral change.

### 2. Bound Claude's Context

Both benchmark paths used the same pinned reviewer:

- `claude-sonnet-5`
- No tools
- No repository exploration
- No built-in MCP servers
- No custom instructions
- One fixed-context review request

This isolated what I actually wanted to measure: whether Jev-prepared context changed cost and review output.

### 3. Add Caching and Safety Rules

Identical PR classifications are cached for the lifetime of the MCP server.

I also kept deterministic safety overrides for sensitive areas such as authentication, concurrency, lifecycle code, persistence, and accessibility.

If filtering did not produce a meaningful reduction, the system fell back to the full patch.

## What Happened Next

I ran 22 paired reviews across 11 public pull requests.

Jev dropped **98 of 264 hunks** and cost only **$0.00255** across the entire benchmark.

The routed path saved money in **15 of 22 runs**. Those winning runs saved **27.9% in aggregate**.

The full result was more modest:

| Metric | Baseline | Jev-routed |
| --- | ---: | ---: |
| Total cost | $2.2529 | $2.2264 |
| Median latency | 85.5s | 58.9s |
| Raw findings | 47 | 50 |

The measured full-sample saving was **1.18%**.

One extreme Claude run cost 305% more than its paired baseline and erased most of the broader savings. Excluding that single outlier gives a sensitivity result of **15.9%**, but that is not the headline result.

Model output and billing variance still matter, even with identical settings.

## What I Learned

1. **Cheap routing cannot control an unrestricted agent.** A model with tools can reload everything removed from its initial prompt.
2. **Jev was not the expensive component.** Its cost was negligible compared with the generative reviewer.
3. **Filtering must be PR-aware.** Hunks often depend on neighboring implementation, configuration, and tests.
4. **Caching matters.** Repeated preparation should not pay for the same decision twice.
5. **Cost is not quality.** Raw finding counts do not prove that findings are correct. Blind adjudication is still required.
6. **Full results matter.** Winning-only and outlier-adjusted numbers help explain behavior, but should never replace the complete benchmark.

## Where I Landed

My goal is to reduce generative-review cost by roughly **20% on suitable pull requests**, not to promise that saving on every run.

The project supports three interfaces:

- An MCP server for coding agents
- A GitHub Action for automated pull-request review
- A CLI for local use and evaluation

The source is available at:

**https://github.com/shubhangi013/prune-review**

The project began with a negative result. That failure forced me to simplify the architecture, control the experiment, and separate routing economics from agent behavior.

The result is less dramatic than my original idea, but much more credible.
