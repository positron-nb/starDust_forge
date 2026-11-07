from shop.pricing import apply_discount


def cart_total(items, percent=0):
    return apply_discount(sum(items), percent)
