import fs from "fs";
import path from "path";
import _ from "lodash";
import mkdirp from "mkdirp";
import fetch from "node-fetch";
import glob from "glob";
import { Telegram } from "./node_modules/telegraf/lib/telegram.js";
import { Telegraf } from "telegraf";
import puppeteer from "puppeteer";

const CONTENT_PATH = "./data";
const HTML_SOURCE = "./page.html";
const TELEGRAM_BOT_TOKEN = _.last(process.argv);

const browser = await puppeteer.launch({ headless: true });

const telegram = new Telegram(TELEGRAM_BOT_TOKEN);
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

const fileNameSnakeCase = (fileName) =>
  fileName
    ? _.snakeCase(path.basename(fileName, path.extname(fileName))) +
      path.extname(fileName)
    : null;

const primaryId = (message) =>
  (
    (message.reply_to_message &&
      (message.reply_to_message.media_group_id ||
        message.reply_to_message.message_id)) ||
    message.media_group_id ||
    message.message_id
  ).toString();

const queue = {};

bot.on(["message", "edited_message"], (ctx) => {
  const message = ctx.editedMessage || ctx.message;

  const chatDirPath = path.join(CONTENT_PATH, `${message.chat.id}`);
  const msgDirPath = path.join(chatDirPath, primaryId(message));

  const dirPath = path.join(msgDirPath, message.message_id.toString());
  console.log(dirPath);
  mkdirp.sync(dirPath);

  // fs.writeFileSync(path.join(dirPath, `message.json`), JSON.stringify(message, null, 2));

  if (message.photo?.length) {
    const photo = _.first(_.orderBy(message.photo, "file_size", "desc"));

    telegram.getFileLink(photo.file_id).then((src) => {
      const filePath = path.join(
        dirPath,
        fileNameSnakeCase(photo.file_name) ||
          photo.file_unique_id + path.extname(new URL(src).pathname)
      );

      if (!fs.existsSync(filePath)) {
        queue[msgDirPath] = (queue[msgDirPath] || 0) + 1;

        fetch(src)
          .then((response) => {
            if (!response.ok) {
              queue[msgDirPath] -= 1;
              console.log(`> ERROR ${response.status}`);
            } else {
              mkdirp.sync(path.dirname(filePath));
              const fileStream = fs.createWriteStream(filePath);

              response.body.pipe(fileStream);

              response.body.on("error", () => {
                queue[msgDirPath] -= 1;
                console.log(`> FAILED!`);
              });

              fileStream.on("finish", () => {
                queue[msgDirPath] -= 1;
                console.log(`> DOWNLOADED`, queue[msgDirPath]);

                if (queue[msgDirPath] == 0) {
                  fs.writeFileSync(
                    path.join(msgDirPath, "page.html"),
                    fs.readFileSync(HTML_SOURCE, "utf8").replace(
                      "{img}",
                      glob
                        .sync(path.join("*", "*.{jpg,jpeg,png}"), {
                          cwd: msgDirPath,
                        })
                        .sort()
                        .map((x) => `<img src="${x}" />`)
                        .join("\n")
                    )
                  );

                  browser.newPage().then((page) => {
                    page
                      .goto(`file://${path.resolve(msgDirPath, "page.html")}`, {
                        waitUntil: "networkidle0",
                      })
                      .then(() => {
                        const pdfFileName = `${primaryId(message)}.pdf`;
                        const pdfFilePath = path.resolve(
                          chatDirPath,
                          pdfFileName
                        );
                        page.pdf({ format: "A4" }).then((pdf) => {
                          fs.writeFileSync(pdfFilePath, pdf);
                          console.log(`>> PDF Created`);
                          ctx
                            .replyWithDocument({
                              source: fs.createReadStream(pdfFilePath),
                              filename: `${primaryId(message)}.pdf`,
                            })
                            .then(() => console.log(`>>> PDF Sent`));
                        });
                      });
                  });
                }
              });
            }
          })
          .catch(() => {
            queue[msgDirPath] -= 1;
            console.log(`> ERROR`);
          });
      }
    });
  }
});

bot.launch();
