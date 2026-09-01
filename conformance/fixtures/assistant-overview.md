# How token budgets work

A token budget caps how much text a model may read and write in one call.
Most providers count **input and output separately**, so a long system prompt
quietly eats into the room left for the answer.

Here is the short version:

1. Tokenize the prompt and count it.
2. Subtract that count from the context window.
3. What remains is the *ceiling* for the completion.

A few practical tips:

- Keep the system prompt under a tenth of the window.
- Trim retrieved documents before you concatenate them.
- Ask for structured output — it compresses surprisingly well.

For the full pricing table see [the provider docs](https://example.com/docs/pricing)
or the [context-window FAQ](https://example.com/faq#context "Context FAQ").

> Rule of thumb: if the answer must be long, the question must be short.
