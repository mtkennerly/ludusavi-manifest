import json
import sys

from steam.client import SteamClient


def main():
    app_ids = [int(arg) for arg in sys.argv[1:]]

    client = SteamClient()
    client.anonymous_login()

    info = client.get_product_info(apps=app_ids)
    print(json.dumps(info, indent=2))


if __name__ == "__main__":
    main()
