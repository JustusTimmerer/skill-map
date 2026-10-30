"""The languages of the server: its catalogs (app/texts.py), the error body with its English message and its values,
the language of an account in the API and in the data block of each page, the mails in the language of their
recipient, and the small pages that the app makes with the keys of their texts."""
from __future__ import annotations

import json
import re

import pytest
from conftest import BASE, PASSWORD, SUBJECTS, count_rows, make_settings, unique

from app import mail, texts
from app.errors import ApiError
from app.security import PASSWORD_MIN

# The German mails of the time before the catalogs, word for word. The catalogs keep them (de/mail.json).
GERMAN = {
    "confirm": ("Bitte bestätige dein Konto bei it-skills.test",
                "Hallo anna,\n\nbitte bestätige deine E-Mail-Adresse mit diesem Link:\n\n"
                "https://it-skills.test/account#confirm=TOKEN\n\n"
                "Die Seite fragt dann nach dem Passwort, das du bei der Registrierung gewählt hast.\n"
                "Der Link gilt 48 Stunden. Erst danach kannst du dich anmelden.\n"
                "Wenn du dich nicht registriert hast, ignoriere diese E-Mail. Dann wird nichts gespeichert.\n"),
    "registered": ("Dein Konto bei it-skills.test",
                   "Hallo,\n\njemand wollte mit dieser E-Mail-Adresse ein neues Konto anlegen. Du hast schon ein Konto.\n\n"
                   "Melde dich hier an: https://it-skills.test/account\n"
                   "Passwort vergessen? Dort kannst du ein neues setzen.\n\n"
                   "Wenn du das nicht warst, ignoriere diese E-Mail. Dein Konto bleibt, wie es ist.\n"),
    "invitation": ("Einladung in das Team Team Nord bei it-skills.test",
                   "Hallo,\n\nanna lädt dich in das Team „Team Nord“ (team-nord) ein, mit der Rolle Leser.\n\n"
                   "Mit diesem Link siehst du die Einladung und nimmst sie an:\n\n"
                   "https://it-skills.test/account#invite=TOKEN\n\n"
                   "Du brauchst dafür ein Konto. Du kannst dich mit jedem Konto anmelden oder ein neues anlegen.\n"
                   "Der Link gilt 7 Tage und nur einmal.\n"
                   "Wenn du die Einladung nicht willst, ignoriere diese E-Mail.\n"),
    "reset": ("Neues Passwort für it-skills.test",
              "Hallo anna,\n\nmit diesem Link setzt du ein neues Passwort:\n\n"
              "https://it-skills.test/account#reset=TOKEN\n\n"
              "Der Link gilt eine Stunde und nur einmal.\n"
              "Wenn du kein neues Passwort wolltest, ignoriere diese E-Mail. Dein Passwort bleibt, wie es ist.\n"),
}
ENGLISH = {
    "confirm": ("Please confirm your account at it-skills.test",
                "Hello anna,\n\nplease confirm your e-mail address with this link:\n\n"
                "https://it-skills.test/account#confirm=TOKEN\n\n"
                "The page then asks for the password that you chose when you registered.\n"
                "The link is valid for 48 hours. You can sign in only after that.\n"
                "If you did not register, ignore this e-mail. Then nothing is stored.\n"),
    "registered": ("Your account at it-skills.test",
                   "Hello,\n\nsomebody wanted to make a new account with this e-mail address. You already have an account.\n\n"
                   "Sign in here: https://it-skills.test/account\n"
                   "Forgot your password? You can set a new one there.\n\n"
                   "If this was not you, ignore this e-mail. Your account stays as it is.\n"),
    "invitation": ("Invitation to the team Team Nord at it-skills.test",
                   "Hello,\n\nanna invites you to the team “Team Nord” (team-nord), with the role reader.\n\n"
                   "With this link you see the invitation and accept it:\n\n"
                   "https://it-skills.test/account#invite=TOKEN\n\n"
                   "You need an account for it. You can sign in with any account or make a new one.\n"
                   "The link is valid for 7 days and works only once.\n"
                   "If you do not want the invitation, ignore this e-mail.\n"),
    "reset": ("New password for it-skills.test",
              "Hello anna,\n\nwith this link you set a new password:\n\n"
              "https://it-skills.test/account#reset=TOKEN\n\n"
              "The link is valid for one hour and works only once.\n"
              "If you did not ask for a new password, ignore this e-mail. Your password stays as it is.\n"),
}


def mails(language: str) -> dict:
    """Each mail of the server in a language, made by the functions of app/mail.py."""
    settings = make_settings("")
    return {
        "confirm": mail.confirm_mail(settings, language, "anna", "TOKEN", 48),
        "registered": mail.already_registered_mail(settings, language),
        "invitation": mail.invite_mail(settings, language, "anna", "Team Nord", "team-nord", "reader", "TOKEN", 7),
        "reset": mail.reset_mail(settings, language, "anna", "TOKEN"),
    }


def text_of(message: dict) -> str:
    """The text of a mail in mailpit, with plain line ends."""
    return message["Text"].replace("\r\n", "\n")


def server_config(page: str) -> dict:
    match = re.search(r'<script type="application/json" id="it-skills-server">(.*?)</script>', page)
    assert match, page[:300]
    return json.loads(match[1])


# The catalogs.

def test_the_languages_of_the_server_are_the_folders_of_its_catalogs():
    assert texts.LANGUAGES == ("en", "de")
    assert sorted(path.name for path in texts.FOLDER.iterdir() if path.is_dir()) == ["de", "en"]
    assert set(texts.PLURALS) >= set(texts.LANGUAGES)


def test_a_text_fills_its_values_and_picks_its_plural_form():
    assert texts.text("en", "error.too_many_maps", max=5, count=5) == "At most 5 maps are possible here."
    assert texts.text("de", "error.too_many_maps", max=5, count=5) == "Hier sind höchstens 5 Maps möglich."
    for language, one, other in (("en", "The link is valid for 1 day and works only once.",
                                  "The link is valid for 7 days and works only once."),
                                 ("de", "Der Link gilt 1 Tag und nur einmal.", "Der Link gilt 7 Tage und nur einmal.")):
        assert texts.text(language, "mail.invitation.validity", count=1) == one
        assert texts.text(language, "mail.invitation.validity", count=7) == other
        assert texts.text(language, "mail.invitation.validity", count=0) == other.replace("7", "0")


def test_a_limit_of_one_names_one_map_and_one_team_in_every_language(make_app, make_client, quick_user):
    # MAX_MAPS_PER_OWNER and MAX_TEAMS_PER_USER can be 1, so the texts of the two limits have a plural (finding D5).
    for language, maps, teams in (("en", "At most 1 map is possible here.", "You can lead at most 1 team."),
                                  ("de", "Hier ist höchstens 1 Map möglich.", "Du kannst höchstens 1 Team leiten.")):
        assert texts.text(language, "error.too_many_maps", max=1, count=1) == maps
        assert texts.text(language, "error.too_many_teams", max=1, count=1) == teams
    anna = quick_user()
    limited = make_client(make_app(max_maps=1, max_teams=1), cookies=dict(anna.cookies))
    assert limited.post("/api/maps", json={"title": "Eins"}).status_code == 201
    refused = limited.post("/api/maps", json={"title": "Zwei"})
    assert refused.status_code == 409 and refused.json() == {
        "error": "too_many_maps", "message": "At most 1 map is possible here.", "params": {"max": 1, "count": 1}}
    assert limited.post("/api/teams", json={"name": "Eins", "handle": unique("t")}).status_code == 201
    refused = limited.post("/api/teams", json={"name": "Zwei", "handle": unique("t")})
    assert refused.status_code == 409 and refused.json() == {
        "error": "too_many_teams", "message": "You can lead at most 1 team.", "params": {"max": 1, "count": 1}}


def test_a_missing_language_takes_english_and_a_missing_key_or_value_raises():
    assert texts.text("fr", "error.not_found") == texts.text(None, "error.not_found") == "Not found."
    with pytest.raises(KeyError, match="no text error.no_such_code"):
        texts.text("en", "error.no_such_code")
    with pytest.raises(KeyError, match="needs the value max"):
        texts.text("de", "error.too_many_origins")
    with pytest.raises(KeyError, match="needs the value count"):
        texts.text("en", "mail.invitation.validity")


def test_a_language_without_a_plural_rule_stops_the_server(tmp_path):
    for code in ("en", "xx"):
        (tmp_path / code).mkdir()
        (tmp_path / code / "errors.json").write_text('{"error.not_found": {"text": "Not found.", "note": "n"}}',
                                                     encoding="utf-8")
    with pytest.raises(RuntimeError, match="no plural rule for xx"):
        texts.load(tmp_path)


# The error body.

def test_an_error_has_its_code_the_english_message_and_its_values(client):
    response = client.post("/api/auth/register", json={"email": f"{unique()}@example.org", "password": "kurz",
                                                       "handle": unique()})
    assert response.status_code == 400
    assert response.json() == {"error": "weak_password", "message": f"The password needs at least {PASSWORD_MIN} characters.",
                               "params": {"min": PASSWORD_MIN, "variant": "short"}}
    response = client.get("/api/maps")
    assert response.json() == {"error": "not_logged_in", "message": "Please sign in.", "params": {}}
    error = ApiError(409, "last_owner", "account", teams="nord, sued")
    assert error.body() == {"error": "last_owner", "message": "You are the only owner of nord, sued. First give the role "
                                                              "to another member, or delete the team.",
                            "params": {"teams": "nord, sued", "variant": "account"}}


def test_the_csrf_error_and_the_origin_error_name_no_address(client, make_client, quick_user):
    forged = make_client(headers={"X-Requested-With": "it-skills", "Origin": "https://evil.example"})
    response = forged.post("/api/auth/login", json={"email": "a@example.org", "password": PASSWORD})
    assert response.status_code == 403
    assert response.json() == {"error": "csrf", "message": "The request was refused because its origin is wrong.",
                               "params": {}}
    owner = quick_user()
    created = owner.post("/api/maps", json={"title": "Karte"}).json()
    response = owner.patch(f"/api/maps/{created['id']}", json={"embed": {"allow": "origins", "origins": ["kein"]}})
    assert response.status_code == 400 and response.json()["params"] == {"origin": "kein"}
    assert response.json()["message"] == ("“kein” is not a valid address of a website. An address looks like "
                                          "https://example.org, without a path.")
    assert "localhost" not in texts.text("de", "error.invalid_origin", origin="x")


# The language of an account in the API.

def test_a_registration_names_its_language_and_english_is_the_default(client, make_client, mailbox, pool):
    german, english = unique(), unique()
    response = client.post("/api/auth/register", json={"email": f"{german}@example.org", "password": PASSWORD,
                                                       "handle": german, "language": "de"})
    assert response.status_code == 202
    assert make_client().post("/api/auth/register", json={"email": f"{english}@example.org", "password": PASSWORD,
                                                          "handle": english}).status_code == 202
    with pool.connection() as conn:
        rows = {row["handle"]: row["language"]
                for row in conn.execute("SELECT o.handle, u.language FROM users u JOIN owners o ON o.id = u.id")}
    assert rows == {german: "de", english: "en"}
    refused = make_client().post("/api/auth/register", json={"email": f"{unique()}@example.org", "password": PASSWORD,
                                                             "handle": unique(), "language": "xx"})
    assert refused.status_code == 400 and refused.json()["error"] == "bad_language"
    assert refused.json()["params"] == {"languages": "en, de"}
    assert count_rows(pool, "users") == 2


def test_the_account_login_and_session_give_the_language_and_patch_changes_it(client, signup, make_client):
    account = signup(client, language="de")
    login = client.post("/api/auth/login", json={"email": account["email"], "password": PASSWORD})
    assert login.json()["language"] == "de"
    assert client.get("/api/auth/session").json()["language"] == "de"
    assert client.get("/api/account").json()["language"] == "de"
    changed = client.patch("/api/account", json={"language": "en"})
    assert changed.status_code == 200 and changed.json() == client.get("/api/account").json()
    assert changed.json()["language"] == "en" and changed.json()["handle"] == account["handle"]
    # A body without the language changes nothing, and an unknown language is refused.
    assert client.patch("/api/account", json={}).json()["language"] == "en"
    refused = client.patch("/api/account", json={"language": "Deutsch"})
    assert refused.status_code == 400 and refused.json()["error"] == "bad_language"
    assert client.get("/api/account").json()["language"] == "en"
    # It needs a session and the headers of a write.
    assert make_client().patch("/api/account", json={"language": "de"}).status_code == 401
    bare = make_client(headers={}, cookies={"__Host-session": client.cookies.get("__Host-session")})
    assert bare.patch("/api/account", json={"language": "de"}).json()["error"] == "csrf"


# The data block of each page.

def test_the_data_block_of_each_page_names_the_language_of_the_account(quick_user, make_client, sample_file):
    anna = quick_user(language="de")
    created = anna.post("/api/maps/import", json=sample_file).json()
    anna.patch(f"/api/maps/{created['id']}", json={"visibility": "public"})
    share = anna.post(f"/api/maps/{created['id']}/shares").json()
    reader = make_client()
    pages = ("/", "/account", f"/{anna.handle}/{created['slug']}", f"/s/{share['token']}")
    for path in pages:
        assert server_config(anna.get(path).text)["language"] == "de", path
        assert server_config(reader.get(path).text)["language"] is None, path
    account = anna.get("/account")
    assert server_config(account.text) == {"mode": "account", "user": {"handle": anna.handle}, "language": "de"}
    assert server_config(reader.get("/account").text) == {"mode": "account", "user": None, "language": None}
    assert account.headers["cache-control"] == "no-store" and "<base" not in account.text
    # The embed view never reads the session.
    assert server_config(anna.get(f"/e/{anna.handle}/{created['slug']}").text)["language"] is None
    anna.patch("/api/account", json={"language": "en"})
    assert server_config(anna.get("/").text)["language"] == "en"


def test_the_account_page_is_the_file_with_the_data_block_after_head(client):
    from app.pages import STATIC

    own = (STATIC / "account.html").read_bytes().decode("utf-8")
    page = client.get("/account").text
    block = re.match(r'(?s)(.*?<head[^>]*>)(<script type="application/json" id="it-skills-server">[^<]*</script>)', page)
    assert block and page.replace(block[2], "", 1) == own


# The mails in the language of their recipient.

@pytest.mark.parametrize("language,expected", [("de", GERMAN), ("en", ENGLISH)])
def test_each_mail_in_each_language(language, expected):
    made = mails(language)
    for kind, (subject, body) in expected.items():
        assert made[kind][0] == subject, kind
        assert made[kind][1].rstrip("\n") == body.rstrip("\n"), kind
    roles = {role: mail.role_label(language, role) for role in ("owner", "editor", "reader")}
    assert roles == ({"owner": "Inhaber", "editor": "Bearbeiter", "reader": "Leser"} if language == "de"
                     else {"owner": "owner", "editor": "editor", "reader": "reader"})


@pytest.mark.parametrize("language", ["de", "en"])
def test_the_mail_of_a_registration_has_the_language_of_the_registration(client, mailbox, language):
    handle = unique()
    email = f"{handle}@example.org"
    client.post("/api/auth/register", json={"email": email, "password": PASSWORD, "handle": handle, "language": language})
    expected = (GERMAN if language == "de" else ENGLISH)["confirm"][0]
    message = mailbox.wait(email, SUBJECTS["confirm"])
    assert message["Subject"] == expected
    assert re.search(rf"\n{re.escape(BASE)}/account#confirm=[A-Za-z0-9_-]+\n", text_of(message))


def test_the_mails_to_an_account_have_the_language_of_the_account(client, signup, make_client, mailbox):
    account = signup(client, language="de")
    # A registration in English with the address of a German account: the mail goes to the account, in German.
    make_client().post("/api/auth/register", json={"email": account["email"], "password": PASSWORD,
                                                   "handle": unique(), "language": "en"})
    assert mailbox.wait(account["email"], SUBJECTS["registered"])["Subject"] == GERMAN["registered"][0]
    make_client().post("/api/auth/reset-request", json={"email": account["email"]})
    assert mailbox.wait(account["email"], SUBJECTS["reset"])["Subject"] == GERMAN["reset"][0]
    client.patch("/api/account", json={"language": "en"})
    make_client().post("/api/auth/reset-request", json={"email": account["email"]})
    message = mailbox.wait(account["email"], "New password")
    assert message["Subject"] == ENGLISH["reset"][0] and f"{BASE}/account#reset=" in text_of(message)


def test_a_new_confirmation_mail_has_the_language_of_the_registration(client, mailbox):
    handle = unique()
    email = f"{handle}@example.org"
    client.post("/api/auth/register", json={"email": email, "password": PASSWORD, "handle": handle, "language": "de"})
    mailbox.wait(email, "bestätige")
    # A reset of an account that nobody confirmed sends the confirmation mail again, in the language of the account.
    client.post("/api/auth/reset-request", json={"email": email})
    assert mailbox.wait(email, "bestätige", count=2)["Subject"] == GERMAN["confirm"][0]


def test_an_invitation_has_the_language_of_the_account_or_of_the_person_who_invites(quick_user, mailbox):
    anna = quick_user(language="de")
    bert = quick_user(language="en")
    team = anna.post("/api/teams", json={"name": "Team Nord", "handle": unique("t")}).json()
    # Bert has an account in English: his invitation is English, though Anna writes German.
    anna.post(f"/api/teams/{team['handle']}/invitations", json={"email": bert.email, "role": "editor"})
    message = mailbox.wait(bert.email, SUBJECTS["invitation"])
    assert message["Subject"] == "Invitation to the team Team Nord at it-skills.test"
    assert f"{anna.handle} invites you to the team “Team Nord” ({team['handle']}), with the role editor." in text_of(message)
    # An address without an account gets the language of Anna.
    stranger = f"{unique()}@example.org"
    anna.post(f"/api/teams/{team['handle']}/invitations", json={"email": stranger, "role": "owner"})
    message = mailbox.wait(stranger, SUBJECTS["invitation"])
    assert message["Subject"] == "Einladung in das Team Team Nord bei it-skills.test"
    assert "mit der Rolle Inhaber." in text_of(message) and "Der Link gilt 7 Tage und nur einmal." in text_of(message)


def test_an_imported_map_without_a_title_gets_the_title_in_the_language_of_the_account(quick_user, sample_file):
    untitled = {key: value for key, value in sample_file.items() if key != "title"}
    assert quick_user(language="de").post("/api/maps/import", json=untitled).json()["title"] == "Importierte Map"
    assert quick_user(language="en").post("/api/maps/import", json=untitled).json()["title"] == "Imported map"


# The small pages of the app.

def test_the_pages_of_the_app_hold_english_with_the_keys_and_load_the_texts(quick_user, make_client, sample_file, make_app):
    anna = quick_user()
    reader = make_client()
    script = '<script src="/assets/i18n.js" defer></script>'
    # Only the owner gets the empty list: a reader gets 404 there, as for an unknown handle (finding A7).
    empty = anna.get(f"/{anna.handle}")
    assert empty.status_code == 200 and script in empty.text and '<html lang="en">' in empty.text
    assert '<p data-i18n="server.list.empty">There are no public maps here yet.</p>' in empty.text
    assert f"<title>{anna.handle}</title>" in empty.text and f"<h1>{anna.handle}</h1>" in empty.text
    created = anna.post("/api/maps/import", json=sample_file).json()
    anna.patch(f"/api/maps/{created['id']}", json={"visibility": "public"})
    listing = reader.get(f"/{anna.handle}").text
    assert '<p data-i18n="server.list.lead">Public maps</p>' in listing and f'href="/{anna.handle}/{created["slug"]}"' in listing
    missing = reader.get("/nobody-here/no-map")
    assert missing.status_code == 404 and script in missing.text
    assert '<p data-i18n="error.not_found">Not found.</p>' in missing.text
    embed = reader.get("/e/nobody-here/no-map")
    assert embed.status_code == 404 and script in embed.text
    assert '<title data-i18n="server.embedMissing.title">Map not found</title>' in embed.text
    bare = make_client(make_app(page_file="/nowhere/index.html"))
    page = bare.get(f"/{anna.handle}/{created['slug']}").text
    assert script in page and 'data-i18n="server.fallback.missing"' in page
    assert re.search(r'<p data-i18n="server.fallback.data">The data is at <a href="/api/public/[^"]+/docs">', page)


def test_a_page_error_with_values_keeps_english_without_a_key(make_app, make_client):
    app = make_app()

    def too_many():
        raise ApiError(409, "too_many_maps", max=3, count=3)

    app.add_api_route("/test/too-many", too_many, methods=["GET"])
    page = make_client(app).get("/test/too-many")
    assert page.status_code == 409 and "<p>At most 3 maps are possible here.</p>" in page.text
