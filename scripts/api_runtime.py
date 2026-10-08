"""In-process request admission and telemetry hooks for the local server."""

controller = None


def before_request():
    if controller is not None:
        controller.before_request()


def after_request(response=None, error=None):
    if controller is not None:
        controller.after_request(response or {}, error)
