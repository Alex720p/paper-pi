"""The pi-deepswe TOML interface, with host-side model connectivity."""

import re
import tomllib
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Prices(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    input: float = Field(ge=0)
    output: float = Field(ge=0)
    cacheRead: float = Field(default=0, ge=0)
    cacheWrite: float = Field(default=0, ge=0)


class ModelConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    base_url: str
    model_id: str = Field(min_length=1)
    api_key_env: str | None = None
    context_window: int = Field(default=32768, ge=4096)
    max_tokens: int = Field(default=4096, ge=1)
    reasoning: bool = False
    thinking: Literal["off", "minimal", "low", "medium", "high", "xhigh", "max"] = "off"
    thinking_level_map: dict[
        Literal["off", "minimal", "low", "medium", "high", "xhigh", "max"], str | None
    ] = Field(default_factory=dict)
    sampling: dict[str, Any] = Field(default_factory=dict)
    compat: dict[str, Any] = Field(default_factory=dict)
    prices: Prices | None = None

    @field_validator("base_url")
    @classmethod
    def validate_url(cls, value):
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("base_url must be an absolute HTTP(S) URL")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("base_url cannot contain credentials, query parameters, or fragments")
        parsed.port  # Validate the port; host inference must retain localhost unchanged.
        return value.rstrip("/")

    @field_validator("model_id")
    @classmethod
    def validate_id(cls, value):
        if value != value.strip() or any(ord(c) < 32 for c in value):
            raise ValueError("model_id cannot contain surrounding whitespace or control characters")
        return value

    @field_validator("api_key_env")
    @classmethod
    def validate_key(cls, value):
        if value is not None and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
            raise ValueError("api_key_env must be an environment variable name, not a secret")
        return value

    @model_validator(mode="after")
    def validate_limits(self):
        if self.max_tokens >= self.context_window:
            raise ValueError("max_tokens must be smaller than context_window")
        if self.thinking != "off" and not self.reasoning:
            raise ValueError("Set reasoning=true before selecting a thinking level")
        if self.thinking in {"xhigh", "max"} and not self.thinking_level_map.get(self.thinking):
            raise ValueError(f"Map {self.thinking} explicitly in model.thinking_level_map")
        if self.thinking in self.thinking_level_map and self.thinking_level_map[self.thinking] is None:
            raise ValueError("The selected thinking level is marked unsupported")
        return self

    @property
    def identity(self):
        return f"benchmark/{self.model_id}"

    def pi_models(self):
        model = {
            "id": self.model_id, "name": self.model_id, "reasoning": self.reasoning,
            "input": ["text"], "contextWindow": self.context_window, "maxTokens": self.max_tokens,
        }
        for field, value in (("thinkingLevelMap", self.thinking_level_map),
                             ("samplingParams", self.sampling), ("compat", self.compat)):
            if value:
                model[field] = value
        if self.prices is not None:
            model["cost"] = self.prices.model_dump()
        return {"providers": {"benchmark": {
            "baseUrl": self.base_url, "api": "openai-completions",
            "apiKey": "${" + self.api_key_env + "}" if self.api_key_env else "unused",
            "models": [model],
        }}}


class RunConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tasks_dir: Path = Path("datasets/deep-swe/tasks")
    jobs_dir: Path = Path("jobs")
    concurrency: int = Field(default=1, ge=1)
    prune_docker_cache: bool = False

    @field_validator("concurrency")
    @classmethod
    def serial_only(cls, value):
        if value != 1:
            raise ValueError("The inference server requires concurrency=1")
        return value


class Config(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: ModelConfig
    run: RunConfig = Field(default_factory=RunConfig)

    @classmethod
    def load(cls, path):
        with Path(path).open("rb") as stream:
            return cls.model_validate(tomllib.load(stream))
