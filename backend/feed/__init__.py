"""The home feed: a delivery surface built on the four subsystems.

Not one of them. It consumes 知识与决策 for its sources and 结果学习 for its
ranking, and adds a contract of its own about what a parent is allowed to be
shown. Forcing four thousand lines of delivery rules into the four boxes would
have been a worse map, not a better one.

    signals.py   what the conversation is about
    delivery.py  what to show for it, and whether it is ready to show
"""

from backend.feed import delivery, signals

__all__ = ["delivery", "signals"]
