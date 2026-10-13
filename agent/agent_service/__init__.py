import pydantic_ai

# The library prints a start-up banner to stderr in processes without tracing. In a function's
# logs it is noise on every cold start.
pydantic_ai.BANNER_ENABLED = False
