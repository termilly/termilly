@rem kubectl with no cluster: a test app sees only what its test sets up.
@if "%1"=="config" (echo error: current-context is not set 1>&2 & exit /b 1)
@echo {"items":[]}
