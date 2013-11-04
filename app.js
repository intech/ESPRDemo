/**
 * Created 03.11.13 13:13
 * Interactive Technology
 */
var express = require('express'),
    http = require('http'),
    Primus = require('primus'),
    Rooms = require('primus-rooms'),
    redis = require('redis'),
    RedisStore = require('connect-redis')(express),
    connect = require('express/node_modules/connect'),
    parseSignedCookie = connect.utils.parseSignedCookie,
    cookie = require('express/node_modules/cookie'),
    MemoryStore = express.session.MemoryStore,
    app = express();

// Основной клиент
var redisClient = redis.createClient(6379, 'localhost', {retry_max_delay: 60000});
redisClient.on('error', function(e) {
    console.log('error', e)
});
redisClient.on("reconnecting", function (params) {
    console.log("Client reconnecting: " + util.inspect(params));
});

// Pub/Sub подключения
var redisSub = redis.createClient(6379, 'localhost', {retry_max_delay: 60000});
var redisPub = redis.createClient(6379, 'localhost', {retry_max_delay: 60000});
redisSub.on('error', function(e) {
    console.log('error', e)
});
redisPub.on('error', function(e) {
    console.log('error', e)
});

redisSub.on('ready', function() {
    redisSub.psubscribe('chat:*');
    redisSub.psubscribe('pm:*');
});

var websocketStore = new MemoryStore();
var sessionKey = 'your secret here';
var store = null;

redisClient.on('ready', function() {
    redisClient.set('online', 0);
    store = new RedisStore({ host: 'localhost', port: 6379, client: redisClient });

    app.configure(function(){
        app.use(express.favicon());
        app.use(express.logger('dev'));
        app.use(express.bodyParser());
        app.use(express.methodOverride());
        app.use(express.cookieParser());
        app.use(express.session({ secret: sessionKey, store: store }));
        app.use(app.router);
        app.use(express.static(__dirname + '/public'));
    });

    var server = http.createServer(app);

    primus = new Primus(server, { transformer: 'sockjs', parser: 'JSON' });

    primus.use('rooms', Rooms);

    primus.authorize(function (data, accept) {
        if(!data.upgrade) return accept();
        if(data.headers.cookie) {
            data.cookie = cookie.parse(data.headers.cookie);
            data.sessionID = parseSignedCookie(data.cookie['connect.sid'], sessionKey);
        } else {
            return accept('No cookie transmitted', false);
        }
        console.log('AUTH:', data.sessionID);
        store.get(data.sessionID, function(err, session) {
            //console.log('session:', err, session);
            if(err) return accept(err);
            // тут вопрос ещё не решён https://github.com/primus/primus/issues/76
            accept();
        });
    });


    primus.on('connection', function (spark) {

        //console.log('!!! spark', spark);
        redisClient.incr('online');
        // Проверяем куки
        if(spark.headers.cookie) {
            // Парсим куки
            spark.cookie = cookie.parse(spark.headers.cookie);
            // Достаём id сессии
            spark.sessionID = parseSignedCookie(spark.cookie['connect.sid'], sessionKey);
            // Выводим
            console.log('AUTH:', spark.sessionID);
            // Получаем из хранилища данные по сессии
            store.get(spark.sessionID, function(err, session) {
                // Выводим
                console.log('session spark:', err, session);
                // Если ошибка
                if(err) return spark.write({ event: 'error', message: err.message });
                // Если сессия закончилась
                console.log('session.user', session.user);
                if(!session.user) return spark.write({ event: 'logout', message: 'Требуется авторизация' });

                // Если всё ок, то обрабатываем данные

                spark.on('data', function(data) {

                    data = data || {};

                    // Все данные структурированные по принципу
                    // data.event - тип передаваемых данных
                    var event = data.event;
                    // data.to - комната или пользователь кому эти данные передаются
                    var to = data.to;
                    // data.message - сообщение
                    var message = data.message;
                    // Выводим данные
                    console.log('Data:', data);

                    // Обработчик запросов
                    switch (event) {

                        case 'join':
                            // Проверяем находится ли наш пользователь в данной комнате
                            if (~spark.rooms().indexOf(to)) {
                                // Да, уже подключён
                                spark.write({ event: 'joined', room: to });
                            } else {
                                // Нет, с начало подключим его к этой комнате
                                spark.join(to, function() {
                                    spark.write({ event: 'joined', room: to });
                                })
                            }
                        break;

                        case 'chat':
                            // Посылаем сообщение
                            spark.room(to).write({ event: 'chat', login: session.user, message: message });
                        break;

                        case 'pm':
                            // Отправляем приватное сообщение в канал
                            redisPub.publish('pm:' + to, JSON.stringify({ event: 'pm', login: session.user, message: message }));
                        break;

                    }

                });
            });
        }

    });

    primus.on('disconnection', function (spark) {
        console.log(spark.id + ' disconnected');
        redisClient.decr('online');
    });

    primus.on('joinroom', function (room, spark) {
        console.log(spark.id + ' joined ' + room);
    });

    primus.on('leaveroom', function (room, spark) {
        console.log(spark.id + ' left ' + room);
    });

    primus.on('leaveallrooms', function (room, spark) {
        console.log(spark.id + ' leaving all rooms:', room);
    });

    primus.on('roomserror', function (error, spark) {
        console.log('room error from ' + spark.id, error);
    });


    // Примеры взаимодействия с вебсокетами из роутов

    // Пример 1. Простой пример с прямым взаимодействием
    app.all('/chat', function(req, res, next) {
        // Работаем с сессией, будем брать эту переменную для вебсокетов
        req.session.user = 'NodeJS';
        // Задаём комнату для сообщения
        var roomId = 'chat';

        // Отправляем сообщение напрямую в комнату (данное решение не масштабируемое!)
        primus.room(roomId).write({ event: 'chat', login: req.session.user, message: 'Первое сообщение в чат от пользователя ' + req.sessionID });

        // Отправляем сообщение через редис (данное решение масштабируемое!)
        redisPub.publish('chat:' + roomId, JSON.stringify({ event: 'chat', login: req.session.user, message: 'Второе сообщение в чат от пользователя ' + req.sessionID }));

        res.json('ok - ' + req.sessionID);
    });

    // Пример 2. Отправка через redis, позволяет масштабировать приложение
    redisSub.on("pmessage", function (pattern, channel, message) {
        console.log("client channel " + pattern + " / " + channel + " / " + message);
        // Делим название канала на 2 части
        var s = channel.split(':');
        // s[0] - первая часьт это тип сообщений chat или pm
        switch(s[0]) {
            case 'pm':
                // Если приватное, то надо отправить только определённому пользователю во всех комнатах
                primus.forEach(function (spark, id, connections) {
                    if (spark.sessionID != s[1]) return;
                    message = JSON.parse(message);
                    spark.write(message);
                });
            break;

            case 'chat':
                // Если общее для комнаты, отправляем в неё
                primus.room(s[1]).write(JSON.parse(message));
            break;
        }
    });
    // Создаём запись в редисе о сообщении
    app.all('/pm', function(req, res, next) {
        // Работаем с сессией, будем брать эту переменную для вебсокетов
        req.session.user = 'NodeJS';
        // Пишем приватное сообщение пользователю в канал pm:ID, где ID - это сессия пользователя
        redisPub.publish('pm:' + req.sessionID, JSON.stringify({ event: 'pm', login: req.session.user, message: 'Твоя сессия на сервере ' + req.sessionID }));
        res.json('ok - ' + req.sessionID);
    });
    // Выводим online каждые 5 секунд
    setInterval(function() {
        console.log('online clients', primus.connected);
    }, 5000);

    server.listen(3000);

});
