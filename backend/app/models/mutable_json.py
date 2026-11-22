from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any
from weakref import ReferenceType, ref

from sqlalchemy.ext.mutable import Mutable, MutableDict, MutableList


class _NestedMutable:
    """중첩된 변경을 가장 바깥 SQLAlchemy JSON 값까지 전달한다."""

    _mutable_parent_ref: ReferenceType[_NestedMutable] | None

    def _set_mutable_parent(self, parent: _NestedMutable) -> None:
        self._mutable_parent_ref = ref(parent)

    def changed(self) -> None:
        Mutable.changed(self)
        parent_ref = getattr(self, "_mutable_parent_ref", None)
        parent = parent_ref() if parent_ref is not None else None
        if parent is not None:
            parent.changed()


class NestedMutableDict(_NestedMutable, MutableDict[str, Any]):
    """모든 하위 사전과 목록의 제자리 변경을 추적하는 JSON 사전."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._mutable_parent_ref = None
        dict.__init__(self)
        initial = dict(*args, **kwargs)
        for key, value in initial.items():
            dict.__setitem__(self, key, _nested_value(value, self))

    @classmethod
    def coerce(cls, key: str, value: Any) -> NestedMutableDict | None:
        if value is None or isinstance(value, cls):
            return value
        if isinstance(value, dict):
            return cls(value)
        return Mutable.coerce(key, value)

    def __setitem__(self, key: str, value: Any) -> None:
        dict.__setitem__(self, key, _nested_value(value, self))
        self.changed()

    def __delitem__(self, key: str) -> None:
        dict.__delitem__(self, key)
        self.changed()

    def clear(self) -> None:
        if self:
            dict.clear(self)
            self.changed()

    _missing = object()

    def pop(self, key: str, default: Any = _missing) -> Any:
        if key in self:
            value = dict.pop(self, key)
            self.changed()
            return value
        if default is self._missing:
            raise KeyError(key)
        return default

    def popitem(self) -> tuple[str, Any]:
        value = dict.popitem(self)
        self.changed()
        return value

    def setdefault(self, key: str, default: Any = None) -> Any:
        if key in self:
            return dict.__getitem__(self, key)
        self[key] = default
        return dict.__getitem__(self, key)

    def update(self, *args: Any, **kwargs: Any) -> None:
        incoming = dict(*args, **kwargs)
        for key, value in incoming.items():
            self[key] = value

    def __ior__(self, other: Mapping[str, Any]) -> NestedMutableDict:
        self.update(other)
        return self


class NestedMutableList(_NestedMutable, MutableList[Any]):
    """모든 하위 사전과 목록의 제자리 변경을 추적하는 JSON 목록."""

    def __init__(self, iterable: Iterable[Any] = ()) -> None:
        self._mutable_parent_ref = None
        list.__init__(self, (_nested_value(value, self) for value in iterable))

    @classmethod
    def coerce(cls, key: str, value: Any) -> NestedMutableList | None:
        if value is None or isinstance(value, cls):
            return value
        if isinstance(value, list):
            return cls(value)
        return Mutable.coerce(key, value)

    def __setitem__(self, index: Any, value: Any) -> None:
        if isinstance(index, slice):
            converted = [_nested_value(item, self) for item in value]
        else:
            converted = _nested_value(value, self)
        list.__setitem__(self, index, converted)
        self.changed()

    def __delitem__(self, index: Any) -> None:
        list.__delitem__(self, index)
        self.changed()

    def append(self, value: Any) -> None:
        list.append(self, _nested_value(value, self))
        self.changed()

    def extend(self, iterable: Iterable[Any]) -> None:
        converted = [_nested_value(value, self) for value in iterable]
        if converted:
            list.extend(self, converted)
            self.changed()

    def insert(self, index: int, value: Any) -> None:
        list.insert(self, index, _nested_value(value, self))
        self.changed()

    def pop(self, index: int = -1) -> Any:
        value = list.pop(self, index)
        self.changed()
        return value

    def remove(self, value: Any) -> None:
        list.remove(self, value)
        self.changed()

    def clear(self) -> None:
        if self:
            list.clear(self)
            self.changed()

    def reverse(self) -> None:
        list.reverse(self)
        self.changed()

    def sort(self, *args: Any, **kwargs: Any) -> None:
        list.sort(self, *args, **kwargs)
        self.changed()

    def __iadd__(self, iterable: Iterable[Any]) -> NestedMutableList:
        self.extend(iterable)
        return self

    def __imul__(self, value: int) -> NestedMutableList:
        list.__imul__(self, value)
        self.changed()
        return self


def _nested_value(value: Any, parent: _NestedMutable) -> Any:
    if isinstance(value, NestedMutableDict | NestedMutableList):
        nested = value
    elif isinstance(value, dict):
        nested = NestedMutableDict(value)
    elif isinstance(value, list):
        nested = NestedMutableList(value)
    else:
        return value
    nested._set_mutable_parent(parent)
    return nested
