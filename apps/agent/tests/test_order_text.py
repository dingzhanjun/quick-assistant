from order_agent.order_text import parse_text_number, read_back


def test_numbers_the_caller_says():
    assert parse_text_number("(404) 555-0123") == "+14045550123"
    assert parse_text_number("4 0 4 5 5 5 0 1 2 3") == "+14045550123"
    assert parse_text_number("1 404 555 0123") == "+14045550123"
    assert parse_text_number("+44 7700 900123") == "+447700900123"
    for bad in ["", None, "12345678", "404555012", "(104) 555-0123", "555-0123", "abc", "+0123456789"]:
        assert parse_text_number(bad) is None, bad


def test_read_back_is_digit_by_digit_in_phone_groups():
    assert read_back("+14045550123") == "I have four zero four, five five five, zero one two three. Is that right?"
    assert "seven seven zero zero" in read_back("+447700900123")  # international: one run of digits
