using UnityEngine;

public class PlayerController : MonoBehaviour
{
    public float speed = 6f;
    int score;

    void Update()
    {
        float x = Input.GetAxis("Horizontal");
        transform.Translate(x * speed * Time.deltaTime, 0, 0);
        if (Input.GetKeyDown(KeyCode.Space)) Jump();
    }

    void Jump() { GetComponent<Rigidbody2D>().AddForce(Vector2.up * 300f); }

    void OnTriggerEnter2D(Collider2D other) { if (other.CompareTag("Apple")) score++; }
}
