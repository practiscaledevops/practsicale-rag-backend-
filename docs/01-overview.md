# 1. Overview

Practiscale AI is a single intelligent system that holds the company knowledge, understands it, and serves it through many products: a chatbot, a content generator, and a public API.

We give a strong general model an excellent memory and clear instructions rather than training a model. Company data lives in a database. The most relevant pieces are found at the moment a person asks. Those pieces plus a careful instruction go to the model. This is Retrieval Augmented Generation.

## The one shared brain

- Upload data once, and every application can use it a second later.
- Nothing is retrained, nothing is redeployed.
- The control plane (admin) configures and uploads. The data plane (apps) reads.

## What to read next

- `02-architecture.md` for the system shape
- `03-tech-stack.md` for the exact technologies
- `04-data-model.md` for the database
- `05-rag-pipeline.md` for how data becomes answers
- `10-getting-started.md` to run it
