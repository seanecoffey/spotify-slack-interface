const express = require("express");
const bodyParser = require("body-parser");
const request = require("request");
const SpotifyWebApi = require("spotify-web-api-node");
const fs = require("fs");
const settings = require("./settings.js");

const HELP_MESSAGE = "```\n\
SPOTIFY - SLACK USAGE:\n\n\
add           - add a track to the current playlist. Example: add - artist - track i.e. /spotify add - john williams - duel of the fates\n\
              - add also works with just a track name, i.e. /spotify add - duel of the fates.\n\n\
remove        - remove a track from a playlist. Example: remove - artist - track i.e. /spotify remove - john williams - duel of the fates\n\
              - remove also works with just a track name, but is more unreliable than specifying the artist name.\n\n\
create        - create a new playlist and set this to the current working playlist.\n\
              - /spotify create - playlist name, i.e. /spotify create - MAR/17\n\n\
deleteplaylist- delete a playlist (if you create a dummy playlist or give an incorrect name).\n\
              - /spotify delete - playlist name, i.e. /spotify delete - MAR/17\n\n\
setplaylist   - set the current working playlist.\n\
              - /spotify setplaylist - best of 2017\n\n\
help          - display this message! /spotify help\n\
```";

let spotifyApi = new SpotifyWebApi({
  clientId: settings.spotify.key,
  clientSecret: settings.spotify.secret,
  redirectUri: settings.spotify.redirect_uri
});

// functions
function sendToSlack(s, sendURL, responseType) {
  let payload = {
    response_type: responseType,
    text: s
  };
  let theRequest = {
    url: sendURL,
    method: "POST",
    json: payload
  };
  request(theRequest, function(error, response, body) {
    if (!error && (response.statusCode == 200)) {
      console.log("sendToSlack: " + s);
    } else {
      console.log("sendToSlack: error, code == " + response.statusCode + ", " + response.body + ".\n");
    }
  });
}

function processTrackQuery(message, responseUrl) {
  return new Promise(function(resolve, reject) {
    let query = ""
    if (message.length === 2) {
      query += "track:" + message[1].trim();
    }
    if (message.length > 2) {
      query += "artist:" + message[1].trim() + " track:" + message[2].trim();
    }
    spotifyApi.searchTracks(query).then((data) => {
      let results = data.body.tracks.items;
      if (results.length === 0) {
        reject("No track found");
        return sendToSlack("Could not find that track.", responseUrl, "ephemeral");
      }
      let track = results[0];
      resolve(track);
    }).catch((err) => {
      reject(err);
      return sendToSlack("process track error" + err, responseUrl, "ephemeral");
    });
  })
}

function addTrack(message, userId, userName, responseUrl) {
  const playlist = JSON.parse(fs.readFileSync("./config/playlist.json", "utf8"));
  if (playlist.id === "") {
    return sendToSlack("A playlist has not been set.", responseUrl, "ephemeral");
  }
  processTrackQuery(message, responseUrl).then((track) => {
    spotifyApi.addTracksToPlaylist(settings.spotify.username, playlist.id, ["spotify:track:" + track.id])
      .then((confirm) => {
        let text = `<@${userId}|${userName}> added <spotify:track:${track.id}|*${track.name}* by * ${track.artists[0].name}*> to the playlist `;
        if (playlist.permalink) {
          text += '<' + playlist.permalink + "|" + playlist.name + ">";
        }
        text += "\n type `/spotify help` for details on how to add songs like this."
        return sendToSlack(text, responseUrl, "in_channel");
      }).catch((err) => {
        return sendToSlack(err.message, responseUrl, "ephemeral");
      });
  }).catch((err) => {
    sendToSlack("add track error" + err, responseUrl, "ephemeral");
  });
}

function removeTrack(message, responseUrl) {
  const playlist = JSON.parse(fs.readFileSync("./config/playlist.json", "utf8"));
  if (playlist.id === "") {
    return sendToSlack("A playlist has not been set.", responseUrl, "ephemeral");
  }
  processTrackQuery(message, responseUrl).then((track) => {
    let tracks = [{
      uri: "spotify:track:" + track.id
    }];
    spotifyApi.removeTracksFromPlaylist(settings.spotify.username, playlist.id, tracks)
      .then((confirm) => {
        let text = `All instances of *${track.name}* by *${track.artist[0].name}* have been removed from the playlist `
        if (playlist.permalink) {
          text += '<' + playlist.permalink + "|" + playlist.name + ">";
        }
        return sendToSlack(text, responseUrl, "ephemeral");
      }).catch((err) => {
        return sendToSlack(err.message, responseUrl, "ephemeral");
      });
  }).catch((err) => {
    sendToSlack("remove track error" + err, responseUrl, "ephemeral");
  });
}

function shareTrack(message, userId, userName, responseUrl) {
  processTrackQuery(message, responseUrl).then((track) => {
    let text = `<@${userId}|${userName}> shared <spotify:track:${track.id}|*${track.name}* by * ${track.artists[0].name}*> but has not added it to a playlist.`;
    return sendToSlack(text, responseUrl, "in_channel");
  }).catch((err) => {
    sendToSlack("share track error" + err, responseUrl, "ephemeral");
  })
}

function createPlaylist(message, userId, userName, responseUrl) {
  if (message.length !== 2) {
    return sendToSlack("Incorrect form for playlist creation, use `/spotify create - playlist name`", responseUrl, "ephemeral");
  }
  let name = message[1];
  spotifyApi.createPlaylist(settings.spotify.username, name, {
    "public": true
  }).then((data) => {
    writePlaylist(data.body);
    return sendToSlack(`<@${userId}|${userName}> created a playlist <${data.body.uri}|*${name}*.>`, responseUrl, "in_channel");
  }).catch((err) => {
    return sendToSlack("create playlist error:" + err, responseUrl, "ephemeral");
  });
}

function deletePlaylist(message, userId, userName, responseUrl) {
  const playlist = JSON.parse(fs.readFileSync("./config/playlist.json", "utf8"));
  if (message.length !== 2) {
    return sendToSlack("Incorrect form for playlist deletion, user `/spotify deleteplaylist - playlist name`", responseUrl, "ephemeral");
  }
  let name = message[1];
  let found;
  spotifyApi.getUserPlaylists(settings.spotify.username).then((data) => {
    for (let i = 0; i < data.body.total; i++) {
      if (data.body.items[i].name === name) {
        spotifyApi.unfollowPlaylist(settings.spotify.username, data.body.items[i].id)
          .then((conf) => {
            found = true;
            if (playlist.id === data.body.items[i].id) {
              let empty = {
                "id": "",
                "name": "",
                "permalink": ""
              };
              writePlaylist(empty);
            }
            return sendToSlack(`Playlist *${name}* has been deleted by <@${userId}|${userName}>.`, responseUrl, "in_channel");
          }).catch((err) => {
            return sendToSlack("unfollowplaylist error " + err, responseUrl, "ephemeral");
          });
      }
    }
  }).catch((err) => {
    return sendToSlack("delete playlist error " + err, responseUrl, "ephemeral");
  });
  setTimeout(function func() {
    if (found !== true) {
      sendToSlack("Playlist not found.", responseUrl, "ephemeral");
    }
  }, 2000);
}

function setPlaylist(message, userId, userName, responseUrl) {
  const playlist = JSON.parse(fs.readFileSync("./config/playlist.json", "utf8"));
  if (message.length !== 2) {
    return sendToSlack("Incorrect form for playlist deletion, user `/spotify deleteplaylist - playlist name`", responseUrl, "ephemeral");
  }
  let name = message[1];
  let found;
  spotifyApi.getUserPlaylists(settings.spotify.username).then((data) => {
    for (let i = 0; i < data.body.total; i++) {
      if (data.body.items[i].name === name) {
        writePlaylist(data.body.items[i]);
        return sendToSlack(`<@${userId}|${userName}> has set the playlist to <${data.body.items[i].uri}|*${data.body.items[i].name}*>.`, responseUrl, "in_channel");
      }
    }
  }).catch((err) => {
    return sendToSlack("set playlist error " + err, responseUrl, "ephemeral");
  });
  setTimeout(function func() {
    if (found !== true) {
      sendToSlack("Playlist not found.", responseUrl, "ephemeral");
    }
  }, 2000);
}

function writePlaylist(playlist) {
  let file = JSON.parse(fs.readFileSync("./config/playlist.json", "utf8"));
  file.id = playlist.id;
  file.name = playlist.name;
  file.permalink = playlist.uri;
  fs.writeFile("./config/playlist.json", JSON.stringify(file, "", "\t"), (err) => {
    if (err) {
      return sendToSlack ("error writing playlist" + err);
    }
  });
}

// Start express app
let app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
  extended: true
}));

app.listen(settings.secrets.port, "0.0.0.0");

app.get("/", function(req, res) {
  if (spotifyApi.getAccessToken()) {
    return res.send('You are logged in.');
  }
  return res.send("<a href=\"/authorise\">Authorise</a>");
});

app.get("/authorise", function(req, res) {
  let scopes = ["playlist-modify-public", "playlist-modify-private"];
  let state = new Date().getTime();
  let authoriseURL = spotifyApi.createAuthorizeURL(scopes, state);
  console.log(authoriseURL);
  res.redirect(authoriseURL);
});

app.get("/callback", function(req, res) {
  spotifyApi.authorizationCodeGrant(req.query.code)
    .then((data) => {
      spotifyApi.setAccessToken(data.body.access_token);
      spotifyApi.setRefreshToken(data.body.refresh_token);
      return res.redirect("/");
    }).catch((err) => {
      return res.send(err);
    });
});

app.get("/refresh", function(req, res) {
  spotifyApi.refreshAccessToken();
  if (spotifyApi.getAccessToken()) {
    return res.send("You are logged in.");
  }
  return res.send("<a href=\"/authorise\">Authorise</a>");
});

app.use("/store", function(req, res, next) {
  if (!settings.slack.token.includes(req.body.token)) {
    return res.status(500).send("Cross site request.");
  }
  next();
});

app.post("/store", function(req, res) {
  console.log(new Date().toUTCString() + " : " + req.body.user_name + " : " + req.body.text);

  const responseUrl = req.body.response_url;
  const userId = req.body.user_id;
  const userName = req.body.user_name;

  res.send("Processing request: `" + req.body.text.trim() + "`");

  spotifyApi.refreshAccessToken().then((data) => {
    spotifyApi.setAccessToken(data.body.access_token);
    if (data.body.refresh_token) {
      spotifyApi.setRefreshToken(data.body.refresh_token);
    }
  }).then((conf) => {
    if (req.body.text.trim().toLowerCase() === "help") {
      return sendToSlack(HELP_MESSAGE, responseUrl, "ephemeral");
    }
    if (req.body.text.trim().length === 0 || req.body.text.indexOf("-") === -1) {
      return sendToSlack("Enter an appropriate command. Try `/spotify help` for usage details.", responseUrl, "ephemeral");
    }
    const pieces = req.body.text.split(" - ");
    const command = pieces[0].trim().toLowerCase();
    if (!["add", "remove", "share", "create", "deleteplaylist", "setplaylist", "help"].includes(command)) {
      return sendToSlack("That is not a valid command. Try `/spotify help` for usage details.", responseUrl, "ephemeral");
    }
    let add = () => addTrack(pieces, userId, userName, responseUrl);
    let remove = () => removeTrack(pieces, responseUrl);
    let share = () => shareTrack(pieces, userId, userName, responseUrl);
    let create = () => createPlaylist(pieces, userId, userName, responseUrl);
    let deleteplaylist = () => deletePlaylist(pieces, userId, userName, responseUrl);
    let setplaylist = () => setPlaylist(pieces, userId, userName, responseUrl);
    let commandFunctions = {
      add,
      remove,
      share,
      create,
      deleteplaylist,
      setplaylist,
    };
    let commandFunction = commandFunctions[command];
    if (commandFunction) {
      commandFunction();
    }
  }).catch((err) => {
    if (err.name === "WebapiError") {
      return sendToSlack("Could not refresh access token. You probably need to re-authorise yourself from your <" + settings.secrets.home_url + "|app's homepage.>", responseUrl, "ephemeral");
    }
    return sendToSlack("/store error " + err.message, responseUrl, "ephemeral");
  });
});

process.on("uncaughtException", (err) => {
  console.log("uncaughtException error" + err);
});
