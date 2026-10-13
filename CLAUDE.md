# Consortium

Consortium is a group chat of AI models. The host writes a message, every agent answers it in a round, any arbiters answer after the agents, and the host decides what happens next. One setting, Interaction, has three values: Independent (each agent reads only the host), Parallel (the agents read each other and answer at the same time), and Round robin (they read each other and answer one after another in list order).

## Cost rule

Real model calls cost the host money or subscription quota. Never send a message to a real model, through the gateway or through the `claude` or `codex` commands, unless the host has said yes for that specific run. Builders, reviewers, and tests use sample mode (`npm run dev:mock`, `CONSORTIUM_MOCK=1`), which writes scripted replies.

## Writing guideline

This applies to chat replies, documents, and all product copy.

- Start with a short, clear summary. Then explain the details from the top down.
- Use simple, calm language and plain words, as in good technical documentation.
- Write the way an expert explains their work in simple terms.
- Use full, natural sentences.
- Use progressive disclosure. Say the whole idea in the first sentence, then expand it in the next, and again in the next. A reader should get the point from the first sentence and see it more precisely with each one after.
- Open with what the reader does or gets. Do not open with a description of the system's shape, such as "One kind of table." or "Three screens, one flow."
- Avoid:
  - em-dashes
  - jargon and coined terms
  - metaphors
  - contrastive "not X, but Y" phrasing
  - short, punchy openers and dramatic one-line closers
  - fast, clipped phrasing that sounds like a coach giving tips

## Product principle

Build the 20 percent that gives 80 percent of the value. A rough version that works well is better than a logical design that is rigid. Where a rule can be handled by instructions to the models, start there. Add code to enforce it only if the models often get it wrong.

## Interface principle

A control carries its own label. If a control needs a sentence to explain it, change the control, not the sentence. Helper text is for state the person cannot see otherwise, such as sample mode, never for describing what a control does.

## Next.js

@AGENTS.md
