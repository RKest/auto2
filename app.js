const puppeteer = require("puppeteer");
const { Parser } = require("json2csv");
const csv = require("csv-parser");
const fs = require("fs");
const util = require("util");
const cp = require("child_process");
const xlsx = require("xlsx");
const workbook = xlsx.readFile('data/map.xlsx');
const sheet_name_list = workbook.SheetNames;
const xlsxJson = xlsx.utils.sheet_to_json(workbook.Sheets[sheet_name_list[0]]);
const icneaToBookingMap = xlsxJson.map(el => ({ [el["ICNEA ID"]]: el["BOOKING ID"] }))
    .reduce((prev, el) => ({ ...prev, ...el }), {});

const sleep = util.promisify(setTimeout);
const rSync = path => fs.readFileSync(path, "utf-8");

const gotoWithFallback = async (page, url, ctr = 3) => {
    return new Promise(async (resolve, reject) => {
        try {
            await page.goto(url, pageGotoOptions);
            resolve();
        } catch(e)
        {
            console.error(`Failed to connect to ${url}, attempting ${ctr} more tires`);
            if(ctr)
                await gotoWithFallback(page, url, ctr - 1);
            else 
                reject(new Error(`Page failed to load at ${url}`));
        }
    });
}

const PrepaymentEnum = {
    WITH_DATE: 0,
    WITH_RESERVARTON: 1,
    WITHOUT_PREPAYMENT: 2,
    AT_ANY_TIME: 3
}

const NULL = "EMPTY";
const DESIERED_ORIGIN = "Booking"
const CONFIG_PATH = __dirname + "/private/config.json";

const RES_PATH = __dirname + "/res";
try {
    fs.mkdirSync(RES_PATH);
}catch(e){
}

const pageGotoOptions = { waitUntil: "networkidle2", timeout: 0 };
const URL_FROM_BOOKING_NUMBER = number => `https://gero.icnea.net/HosOrdReserva.aspx?res=${number}`;
const ICNEA_REFERENCE_NUMBER = async page => await page.$eval("#referencia", el => el.value);
const ICNEA_RESERVATION_DATE = async page =>
    await page.$eval("input[name=datareserva]", el => el.value.trim().slice(0, 10));

const ICENA_FILL_EMAIL = async (page, email) =>
    await page.$eval("#Email", (el, val) => el.value = val, email);
const ICENA_FILL_PASSWD = async (page, passwd) =>
    await page.$eval("#Contrasenya", (el, val) => el.value = val, passwd);
const ICENA_PROCEED = async page => {
    await page.$eval("#Login", el => el.click());
}

const BOOKING_FILL_UNAME = async page =>
    await page.$eval("._2XLcoGj27PmEfeIS8BIkNh", el => el.value = "letmalaga");
const BOOKING_FILL_PASSWD = async (page, passwd) =>
    await page.$eval("._2XLcoGj27PmEfeIS8BIkNh", (el, passwd) => el.value = passwd, passwd);
const BOOKING_PROCEED = async page => {
    await page.$eval("._3idbYJ1oAGD-sl-6gdCR2e", el => el.click());
    await page.waitForNavigation(pageGotoOptions);
}
const BOOKING_SES_ID = page => {
    const urlString = page.url();
    const url = new URL(urlString);
    const searchParams = url.searchParams;
    return searchParams.get("ses");
}

const BOOKING_URL = (ses, obj) =>
    `https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/booking.html?lang=en&ses=${ses}&res_id=${obj.res_id}&hotel_id=${obj.hotel_id}`;

const BOOKING_ARRIVAL_DATE = async (page, icneaId) => {
    try {
        const contents = await page.$eval(".bui-grid__column-full > * > p:nth-child(2)", el => el.textContent);
        const reg = new RegExp("\\d.*.\\d");
        const datePart = contents.match(reg);
        const date = new Date(datePart);
        return date;
    } catch (e) {
        throw `No arrival date found for person with icnea id of ${icneaId}`;
    }
}

const BOOKING_PREPAYMENT_MESSAGE = async (page, icneaId) => {
    try {
        return await page.$$eval(".res-policies__row", els => {
            const rightEl = els.find(el =>
                el.childNodes[0].childNodes[0].childNodes[0].textContent.trim() === "Prepayment");
            return rightEl.childNodes[0].childNodes[2].childNodes[0].textContent.trim();
        });
    }
    catch (e) {
        throw `No prepayment message for person with icena id of ${icneaId}`;
    }
}



const DATA_PATH = __dirname + "/data/a.csv";
//CHORME PATH:
//"C:\Program Files\Google\Chrome\Application\chrome.exe"
///CHROME PATH

const results = [];
fs.createReadStream(DATA_PATH)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', async () => {
        var config;
        try {
            config = JSON.parse(rSync(CONFIG_PATH));
        } catch (e) {
            throw "No config.json in the '/private' folder";
        }
        if (!config.bookingPasswd)
            throw "No 'bookingPasswd' defined in config.json";
        if (!config.bookingUrl)
            throw "No 'bookingUrl' defined in config.json";
        if (!config.icneaEmail)
            throw "No 'icneaEmail' defined in config.json";
        if (!config.icneaPasswd)
            throw "No 'icneaPasswd' defined in config.json";
        if (!config.chromeExePath)
            throw "No 'chromeExePath' defined in config.json";

        cp.spawn(config.chromeExePath, ["--remote-debugging-port=9222"], { detached: true });
        await sleep(10000);
        const browser = await puppeteer.connect({
            browserURL: "http://127.0.0.1:9222"
        });

        const [bookingPage, icneaPage] = await Promise.all([
            browser.newPage(),
            browser.newPage()
        ]);

        await gotoWithFallback(icneaPage, "https://gero.icnea.net/Servidor.aspx");
        await ICENA_FILL_EMAIL(icneaPage, config.icneaEmail);
        await ICENA_FILL_PASSWD(icneaPage, config.icneaPasswd);
        await ICENA_PROCEED(icneaPage);

        await gotoWithFallback(bookingPage, config.bookingUrl);
        await BOOKING_FILL_UNAME(bookingPage);
        await BOOKING_PROCEED(bookingPage);
        await BOOKING_FILL_PASSWD(bookingPage, config.bookingPasswd);
        await BOOKING_PROCEED(bookingPage);
        const sesId = BOOKING_SES_ID(bookingPage);

        const parsedResults = [];
        for (const data of results) {
            const keys = Object.keys(data)[0].split(";");
            const values = Object.values(data)[0].split(";");
            const tmpObj = {};
            for (var i = 0; i < keys.length; ++i) {
                tmpObj[keys[i]] = values[i] ?? NULL;
            }
            parsedResults.push(tmpObj);
        }

        const originKey = "Origin";
        const filteredResults = parsedResults.filter(el => el[originKey] === DESIERED_ORIGIN);
        if (filteredResults === undefined)
            throw `No csv column with the key of '${originKey}'`;
        //Is equal to "Booking" but is not "js equal" to "Booking"
        const bookingKey = Object.keys(filteredResults[0])[0];
        const NOT_FOUND_KEY = "00000000";
        const firstPaymentDateKey = Object.keys(filteredResults[0])[36];
        const propertyIcneaKeyKey = Object.keys(filteredResults[0])[37];
        const filteredBookingObjects = filteredResults.map(el => {
            return ({
                icneaId: el[bookingKey],
                res_id: "",
                hotel_id: icneaToBookingMap[el[propertyIcneaKeyKey]] ?? NOT_FOUND_KEY
            });
        });


        const csvParser = new Parser({
            delimiter: ";"
        });

        const csvParserNoHeaders = new Parser({
            delimiter: ";",
            header: false
        });

        var progressJSON;
        try {
            progressJSON = JSON.parse(rSync(RES_PATH + "/prog.json"));
        }catch(e)
        {
            progressJSON = {
                i: 0,
                outof: filteredBookingObjects.length
            }; 
        }

        const aSync = line => fs.appendFileSync(RES_PATH + "/data2.csv", line, "utf-8");
        const updateProgress = progressJSON =>
            fs.writeFileSync(RES_PATH + "/prog.json", JSON.stringify(progressJSON, null, 2), "utf-8");
        for (; progressJSON.i < filteredBookingObjects.length; progressJSON.i++) {
            const i = progressJSON.i;
            try {
                const bookingObj = filteredBookingObjects[i];
                if (bookingObj.hotel_id === NOT_FOUND_KEY)
                    throw `No hotel id mapped for guest with icnea id of: ${bookingObj.icneaId}`;

                const icneaUrl = URL_FROM_BOOKING_NUMBER(bookingObj.icneaId);
                await gotoWithFallback(icneaPage, icneaUrl);
                const referenceNumber = await ICNEA_REFERENCE_NUMBER(icneaPage);
                const reservationDate = await ICNEA_RESERVATION_DATE(icneaPage);
                bookingObj.res_id = referenceNumber;

                const bookingUrl = BOOKING_URL(sesId, bookingObj);
                await gotoWithFallback(bookingPage, bookingUrl);

                const arrivalDate = await BOOKING_ARRIVAL_DATE(bookingPage, bookingObj.icneaId);
                const prepaymentMessage = await BOOKING_PREPAYMENT_MESSAGE(bookingPage, bookingObj.icneaId);
                const messageTypeObject = determinePaymentTimeType(prepaymentMessage);

                if (messageTypeObject.type === PrepaymentEnum.WITH_DATE) {
                    arrivalDate.setDate(arrivalDate.getDate() - messageTypeObject.noDays);
                    const dateString = `${arrivalDate.getDate()}/${arrivalDate.getMonth() + 1}/${arrivalDate.getFullYear()}`;
                    filteredResults[i][firstPaymentDateKey] = dateString;
                }
                else if (messageTypeObject.type === PrepaymentEnum.WITHOUT_PREPAYMENT) {
                    filteredResults[i][firstPaymentDateKey] = "_Not needed";
                }
                else if (messageTypeObject.type === PrepaymentEnum.WITH_RESERVARTON) {
                    filteredResults[i][firstPaymentDateKey] = reservationDate;
                }
                else if (messageTypeObject.type === PrepaymentEnum.AT_ANY_TIME) {
                    filteredResults[i][firstPaymentDateKey] = "_At any time";
                }
                else {
                    filteredResults[i][firstPaymentDateKey] = "_Unknown";
                    console.log(prepaymentMessage);
                }
                const data = filteredResults[i];
                const parser = i === 0 ? csvParser : csvParserNoHeaders;
                const parsedCSVLine = parser.parse(data);
                aSync(parsedCSVLine + "\n");
                updateProgress(progressJSON);
            }
            catch (e) {
                console.log(e);
                filteredResults[i][firstPaymentDateKey] = "_ERROR";
                const data = filteredResults[i];
                const parser = i === 0 ? csvParser : csvParserNoHeaders;
                const parsedCSVLine = parser.parse(data);
                aSync(parsedCSVLine + "\n");
                updateProgress(progressJSON);
            }

        }
        progressJSON.i = 0;
        updateProgress(progressJSON);
        browser.close();
    }).on("error", () => {
        throw "Create 'a.csv' in the data foler";
    });


const determinePaymentTimeType = (str) => {
    let ret = -1;
    const withDateRegex = new RegExp("\\d+\\sday");
    const withoutPrepaymentRegex = new RegExp("No prepayment");
    const withReservationRegex = new RegExp("after reservation");
    const atAnyTimeRegex = new RegExp("at any time");
    if (withDateRegex.test(str))
        ret = PrepaymentEnum.WITH_DATE;
    if (withReservationRegex.test(str))
        ret = PrepaymentEnum.WITH_RESERVARTON;
    if (withoutPrepaymentRegex.test(str))
        ret = PrepaymentEnum.WITHOUT_PREPAYMENT;
    if (atAnyTimeRegex.test(str))
        ret = PrepaymentEnum.AT_ANY_TIME;

    if (ret === PrepaymentEnum.WITH_DATE) {
        const numRegex = new RegExp("\\d+");
        const match = str.match(withDateRegex)[0];
        const numberOfDays = +match.match(numRegex)[0];
        return {
            type: PrepaymentEnum.WITH_DATE,
            noDays: numberOfDays,
        }
    }
    else {
        return {
            type: ret,
            noDays: 0
        }
    }
}
