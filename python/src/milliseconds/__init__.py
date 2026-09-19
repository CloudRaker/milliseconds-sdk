"""Typed decisions over text, from milliseconds.ai.

from milliseconds import DecisionMachine

dm = DecisionMachine()            # reads MS_API_KEY
r = dm.classify(ticket, LABELS)   # ClassifyResult
"""

from ._client import AsyncDecisionMachine, DecisionMachine
from ._errors import (
    AuthenticationError,
    ConnectionError,
    InvalidRequestError,
    MillisecondsError,
    OverloadedError,
    QuotaExceededError,
    RateLimitError,
    RunnerError,
)
from ._models import (
    AnswerResult,
    CallOpts,
    ClassifyResult,
    ClassifyTreeLevel,
    ClassifyTreeResult,
    Entity,
    Field,
    RateLimit,
    RateResult,
    Results,
    Tree,
    TreeNode,
    Usage,
    VerifyResult,
    YesNoResult,
)
from ._transport import VERSION as __version__

__all__ = [
    "AnswerResult",
    "AsyncDecisionMachine",
    "AuthenticationError",
    "CallOpts",
    "ClassifyResult",
    "ClassifyTreeLevel",
    "ClassifyTreeResult",
    "ConnectionError",
    "DecisionMachine",
    "Entity",
    "Field",
    "InvalidRequestError",
    "MillisecondsError",
    "OverloadedError",
    "QuotaExceededError",
    "RateLimit",
    "RateLimitError",
    "RateResult",
    "Results",
    "RunnerError",
    "Tree",
    "TreeNode",
    "Usage",
    "VerifyResult",
    "YesNoResult",
    "__version__",
]
