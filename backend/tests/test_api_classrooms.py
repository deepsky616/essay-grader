def _create(client, name="6학년 3반", students=None):
    selected_students = (
        students
        if students is not None
        else [
            {"number": 1, "name": "김미래", "absent": False},
            {"number": 2, "name": "박균형", "absent": False},
        ]
    )
    return client.post(
        "/api/classrooms",
        json={
            "name": name,
            "students": selected_students,
        },
    )


def test_create_classroom_with_students(client) -> None:
    response = _create(client)

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "6학년 3반"
    assert [student["number"] for student in body["students"]] == [1, 2]


def test_classroom_and_student_names_are_trimmed(client) -> None:
    response = _create(
        client,
        name=" 6-3 ",
        students=[{"number": 1, "name": " 김미래 ", "absent": False}],
    )

    assert response.status_code == 201
    assert response.json()["name"] == "6-3"
    assert response.json()["students"][0]["name"] == "김미래"


def test_paste_roster_text(client) -> None:
    response = client.post(
        "/api/classrooms/parse-roster",
        json={"text": "1\t김미래\n2\t박균형\n3   이자율"},
    )

    assert response.status_code == 200
    assert response.json()["students"] == [
        {"number": 1, "name": "김미래"},
        {"number": 2, "name": "박균형"},
        {"number": 3, "name": "이자율"},
    ]


def test_parse_roster_ignores_blank_lines(client) -> None:
    response = client.post(
        "/api/classrooms/parse-roster",
        json={"text": "1\t김미래\n\n \n2\t박균형"},
    )

    assert response.status_code == 200
    assert len(response.json()["students"]) == 2


def test_parse_roster_reports_bad_line_without_echoing_name(client) -> None:
    private_line = "번호가없는민감한이름"
    response = client.post(
        "/api/classrooms/parse-roster",
        json={"text": f"1\t김미래\n{private_line}"},
    )

    assert response.status_code == 400
    assert "2번째 줄" in response.json()["detail"]
    assert private_line not in response.json()["detail"]


def test_parse_roster_rejects_duplicate_number(client) -> None:
    response = client.post(
        "/api/classrooms/parse-roster",
        json={"text": "1\t김미래\n1\t박균형"},
    )

    assert response.status_code == 400
    assert "번호" in response.json()["detail"]


def test_duplicate_number_is_rejected(client) -> None:
    response = _create(
        client,
        students=[
            {"number": 1, "name": "김미래", "absent": False},
            {"number": 1, "name": "박균형", "absent": False},
        ],
    )

    assert response.status_code == 400
    assert "번호" in response.json()["detail"]


def test_mark_absent_student(client) -> None:
    created = _create(
        client,
        name="6-3",
        students=[{"number": 1, "name": "김미래", "absent": False}],
    ).json()

    response = client.patch(
        f"/api/classrooms/{created['id']}/students/{created['students'][0]['id']}",
        json={"absent": True},
    )

    assert response.status_code == 200
    assert response.json()["absent"] is True


def test_update_student_name_is_trimmed(client) -> None:
    created = _create(client).json()
    student = created["students"][0]

    response = client.patch(
        f"/api/classrooms/{created['id']}/students/{student['id']}",
        json={"name": " 새이름 "},
    )

    assert response.status_code == 200
    assert response.json()["name"] == "새이름"


def test_student_cannot_be_updated_through_other_classroom(client) -> None:
    first = _create(client, name="첫 반").json()
    second = _create(client, name="둘째 반").json()

    response = client.patch(
        f"/api/classrooms/{second['id']}/students/{first['students'][0]['id']}",
        json={"absent": True},
    )

    assert response.status_code == 404


def test_list_and_get_classrooms(client) -> None:
    first = _create(client, name="첫 반").json()
    second = _create(client, name="둘째 반").json()

    listed = client.get("/api/classrooms")
    fetched = client.get(f"/api/classrooms/{first['id']}")

    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()] == [second["id"], first["id"]]
    assert fetched.json()["name"] == "첫 반"


def test_missing_classroom_and_student_return_404(client) -> None:
    assert client.get("/api/classrooms/999").status_code == 404
    assert (
        client.patch(
            "/api/classrooms/999/students/999",
            json={"absent": True},
        ).status_code
        == 404
    )


def test_invalid_create_payload_is_rejected(client) -> None:
    assert _create(client, name="   ").status_code == 422
    assert _create(client, students=[]).status_code == 422
    assert (
        _create(
            client,
            students=[{"number": 0, "name": "김미래", "absent": False}],
        ).status_code
        == 422
    )
    response = client.post(
        "/api/classrooms",
        json={
            "name": "6-3",
            "students": [
                {"number": 1, "name": "김미래", "absent": False, "extra": "x"}
            ],
        },
    )
    assert response.status_code == 422


def test_empty_patch_and_blank_name_are_rejected(client) -> None:
    created = _create(client).json()
    path = f"/api/classrooms/{created['id']}/students/{created['students'][0]['id']}"

    assert client.patch(path, json={}).status_code == 422
    assert client.patch(path, json={"name": "  "}).status_code == 422


def test_empty_or_oversized_roster_text_is_rejected(client) -> None:
    assert (
        client.post("/api/classrooms/parse-roster", json={"text": " \n "}).status_code
        == 400
    )
    assert (
        client.post(
            "/api/classrooms/parse-roster",
            json={"text": "1\t김미래\n" * 501},
        ).status_code
        == 400
    )
