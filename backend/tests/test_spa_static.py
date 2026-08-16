from fastapi.testclient import TestClient

from app.main import create_app


def _static_client(tmp_path):
    static_dir = tmp_path / "static"
    assets_dir = static_dir / "assets"
    assets_dir.mkdir(parents=True)
    (static_dir / "index.html").write_text(
        "<!doctype html><title>local-spa-marker</title>", encoding="utf-8"
    )
    (assets_dir / "app.js").write_text(
        "globalThis.localSpaMarker = true;", encoding="utf-8"
    )
    return TestClient(create_app(static_dir=static_dir))


def test_static_root_and_asset_are_served(tmp_path):
    client = _static_client(tmp_path)

    root = client.get("/")
    asset = client.get("/assets/app.js")

    assert root.status_code == 200
    assert "local-spa-marker" in root.text
    assert asset.status_code == 200
    assert "localSpaMarker" in asset.text


def test_browser_route_falls_back_to_spa_index(tmp_path):
    response = _static_client(tmp_path).get("/assessments/12/rubric")

    assert response.status_code == 200
    assert "local-spa-marker" in response.text


def test_missing_asset_and_api_do_not_fall_back_to_html(tmp_path):
    client = _static_client(tmp_path)

    missing_asset = client.get("/assets/missing.js")
    missing_api = client.get("/api/not-a-route")

    assert missing_asset.status_code == 404
    assert "local-spa-marker" not in missing_asset.text
    assert missing_api.status_code == 404
    assert "local-spa-marker" not in missing_api.text


def test_non_get_browser_route_keeps_method_error(tmp_path):
    response = _static_client(tmp_path).post("/settings")

    assert response.status_code == 405


def test_static_symlink_is_not_mounted(tmp_path):
    actual = tmp_path / "actual"
    actual.mkdir()
    (actual / "index.html").write_text("private-marker", encoding="utf-8")
    link = tmp_path / "linked-static"
    link.symlink_to(actual, target_is_directory=True)

    response = TestClient(create_app(static_dir=link)).get("/")

    assert response.status_code == 404
    assert "private-marker" not in response.text
