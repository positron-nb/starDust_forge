from shop.cart import cart_total


def test_no_discount():
    assert cart_total([10, 20]) == 30


def test_ten_percent():
    assert cart_total([50, 50], 10) == 90
