from fake_server import EXAMPLE_CONTENT

from nam_agent.policy.canonical import canonical_json, content_sha256, make_etag

VECTOR = "0587ffd890ccf836680f39fafb4740e3bf94185e7b8d8f26c6502560e14775cf"


def test_contract_test_vector():
    assert content_sha256(EXAMPLE_CONTENT) == VECTOR


def test_key_order_does_not_matter_but_array_order_does():
    reordered = dict(reversed(list(EXAMPLE_CONTENT.items())))
    assert content_sha256(reordered) == VECTOR
    swapped = dict(EXAMPLE_CONTENT, allowed_domains=list(reversed(EXAMPLE_CONTENT["allowed_domains"])))
    assert content_sha256(swapped) != VECTOR


def test_canonical_form():
    assert canonical_json({"b": 1, "a": {"d": [2, 1], "c": "ü"}}) == '{"a":{"c":"ü","d":[2,1]},"b":1}'


def test_etag_format():
    assert make_etag("POL-001", 7, VECTOR) == '"POL-001:7:0587ffd8"'
